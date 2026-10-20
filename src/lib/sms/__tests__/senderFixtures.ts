/**
 * Local-QA fixtures for verified billed senders (TW-4F sender readiness, migration 20261204090000). Synthetic: no Twilio. The evidence below is exactly the
 * normalized shape the server builds from read-only provider reads; the database judges it (_tw4sr_judge). Fake evidence is accepted only where the
 * LOCAL-QA marker table public.tw4_local_qa_only exists (never created by a migration).
 */
import { randomBytes } from "node:crypto";

export type Rpc = (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { code?: string; message?: string } | null }>;

export const hex32 = () => randomBytes(16).toString("hex");
export const sid = (prefix: "MG" | "QE" | "PN" | "BN" | "AC") => `${prefix}${hex32()}`;

export type SenderIds = { mg: string; qe: string; pn: string; e164: string; bn: string };
export const newSenderIds = (e164: string, shared: Partial<Pick<SenderIds, "mg" | "qe" | "bn">> = {}): SenderIds => ({
  mg: shared.mg ?? sid("MG"),
  qe: shared.qe ?? sid("QE"),
  bn: shared.bn ?? sid("BN"),
  pn: sid("PN"),
  e164,
});

export const LOCAL_QA_MARKER = "create table if not exists public.tw4_local_qa_only (note text); revoke all on public.tw4_local_qa_only from public, anon, authenticated, service_role;";

/** the business's own brand, registered by the runner on this subaccount (what the judge looks for) */
export const brandStepSql = (studio: string, account: string, bn: string) =>
  `insert into public.studio_sms_provisioning_steps (onboarding_id, studio_id, step_key, submission_seq, status, provider_sid, mock, twilio_account_sid)
   values (gen_random_uuid(), '${studio}', 'B1', 0, 'succeeded', '${bn}', false, '${account}')`;

export function evidenceFor(account: string, ids: SenderIds, over: Record<string, Record<string, unknown> | unknown[]> = {}) {
  const base: Record<string, unknown> = {
    account: { sid: account, status: "active" },
    service: { sid: ids.mg, account_sid: account, us_app_to_person_registered: true, inbound_route_ok: true },
    campaign: { sid: ids.qe, account_sid: account, messaging_service_sid: ids.mg, campaign_status: "VERIFIED", mock: false, brand_registration_sid: ids.bn, us_app_to_person_usecase: "MIXED" },
    brand: { sid: ids.bn, status: "APPROVED", mock: false },
    number: { sid: ids.pn, account_sid: account, phone_number: ids.e164, sms_capable: true, status: "in-use" },
    service_number: { sid: ids.pn, service_sid: ids.mg, account_sid: account },
    read_errors: [],
    digests: {},
  };
  for (const [k, v] of Object.entries(over)) base[k] = Array.isArray(v) ? v : { ...(base[k] as Record<string, unknown>), ...v };
  return base;
}

/** record + verify (fake evidence): the studio ends with an approved, ready sender. Returns the identifiers and the approved row id. */
export async function readySender(
  rpc: Rpc,
  aged: (sql: string) => void,
  input: { studio: string; account: string; actor: string; ids: SenderIds; brandStep?: boolean },
): Promise<{ ids: SenderIds; senderId: string }> {
  if (input.brandStep !== false) aged(brandStepSql(input.studio, input.account, input.ids.bn));
  const rec = await rpc("tw4_sender_record", {
    p_studio_id: input.studio, p_actor: input.actor, p_messaging_service_sid: input.ids.mg, p_campaign_sid: input.ids.qe, p_phone_number_sid: input.ids.pn,
    p_sender_e164: input.ids.e164, p_reason: "fixture: subaccount sending identity",
  });
  if (rec.error) throw new Error(`record failed: ${JSON.stringify(rec.error)}`);
  const pendingId = (rec.data as { sender_id: string }).sender_id;
  const ver = await rpc("tw4_sender_verify", {
    p_studio_id: input.studio, p_sender_id: pendingId, p_actor: input.actor, p_evidence: evidenceFor(input.account, input.ids), p_attested_opt_out: true, p_source: "fake",
  });
  if (ver.error) throw new Error(`verify failed: ${JSON.stringify(ver.error)}`);
  const out = ver.data as { outcome: string; code: string | null; sender_id: string };
  if (out.outcome !== "verified") throw new Error(`verify outcome ${out.outcome} ${out.code}`);
  return { ids: input.ids, senderId: out.sender_id };
}
