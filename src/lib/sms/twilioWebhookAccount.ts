import "server-only";

import type { RedactedSecret, SubaccountTokenProvider } from "@/lib/sms/twilioIsv/account";
import { twilioSignatureMatches, verifyTwilioWebhook } from "@/lib/sms/twilioWebhook";

/**
 * TW-4F provider integration: account-aware Twilio webhook verification (Twilio ticket #29647095, answers 3-5).
 *
 *  - A webhook for a message sent from a studio legal business's SUBACCOUNT is signed with that subaccount's own Auth Token. The parent token
 *    cannot verify it, and accepting the parent token for it would be wrong anyway.
 *  - The token is retrieved on demand from the parent account (never stored), cached briefly in memory, and re-read ONCE when a signature does not
 *    verify, because a rotation has no overlap window: right after it, the cached token is stale and Twilio already signs with the new one.
 *    Re-reads are spaced per account (SubaccountTokenProvider.refresh), so forged requests cannot drive parent-credential traffic to Twilio.
 *  - The OLD token is never accepted after a rotation (a rotation may be a response to a leak). A genuine callback signed just before the rotation
 *    is therefore rejected; that is the documented cost (see docs/twilio/TW-4F_Provider_Integration.md).
 *
 * Order of checks (each failure is final, nothing is mutated before the end):
 *  1. no X-Twilio-Signature                      -> 403, no lookup, no token read
 *  2. AccountSid absent or the parent's own      -> the existing parent-token verification (unchanged behavior)
 *  3. AccountSid malformed                       -> 403
 *  4. AccountSid not an active/suspended subaccount of a DanceFlow legal business (database) -> 403, no token read
 *  5. subaccount verification switched off        -> 503 (a known subaccount, but this deployment cannot verify it)
 *  6. signature with the current token, then (once, spaced) with a re-read token -> ok, else 403
 *
 * Step 4 reads the database BEFORE the signature is verified (the token to verify with depends on the account). It is one indexed, read-only
 * lookup by SID through a service-role function that returns only ids and a status; the routes rate-limit rejected requests per IP.
 *
 * A verified subaccount identity carries the studios of its legal business. Routes MUST check that the studio a webhook would affect is one of
 * them (`webhookMayActForStudio`): a subaccount's token can never change another business's data.
 */

export type WebhookAccountRecord =
  | { found: false }
  | { found: true; legalEntityId: string; status: "active" | "suspended"; studioIds: string[] };

export type VerifiedWebhookAccount =
  | { kind: "parent" }
  | { kind: "subaccount"; accountSid: string; legalEntityId: string; studioIds: string[] };

export type WebhookAccountVerification =
  | { ok: true; account: VerifiedWebhookAccount }
  | {
      ok: false;
      status: 403 | 503;
      reason:
        | "twilio_auth_token_missing"
        | "twilio_signature_missing"
        | "twilio_signature_invalid"
        | "twilio_account_malformed"
        | "twilio_account_unknown"
        | "twilio_account_lookup_failed"
        | "twilio_subaccount_verification_disabled"
        | "twilio_subaccount_token_unavailable";
    };

export type WebhookAccountDeps = {
  /** The parent (ISV) Account SID: TWILIO_ACCOUNT_SID. */
  parentAccountSid: string;
  /** Resolves an UNVERIFIED AccountSid to one of our subaccounts (tw4_webhook_account). Throws on a database failure. */
  lookupAccount(accountSid: string): Promise<WebhookAccountRecord>;
  /** Subaccount token source, or null when this deployment does not verify subaccount webhooks (the switch is off). */
  tokens: Pick<SubaccountTokenProvider, "tokenFor" | "refresh"> | null;
  /** The parent-token verification (defaults to verifyTwilioWebhook). */
  verifyParent?: typeof verifyTwilioWebhook;
};

const ACCOUNT_SID = /^AC[0-9a-fA-F]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function verifyTwilioWebhookAccount(request: Request, params: Record<string, string>, deps: WebhookAccountDeps): Promise<WebhookAccountVerification> {
  if (!String(request.headers.get("x-twilio-signature") ?? "").trim()) {
    return { ok: false, status: 403, reason: "twilio_signature_missing" };
  }

  const claimed = String(params.AccountSid ?? "").trim();
  const parentSid = String(deps.parentAccountSid ?? "").trim();
  if (!claimed || claimed === parentSid) {
    const parent = (deps.verifyParent ?? verifyTwilioWebhook)(request, params);
    return parent.ok ? { ok: true, account: { kind: "parent" } } : parent;
  }
  if (!ACCOUNT_SID.test(claimed)) return { ok: false, status: 403, reason: "twilio_account_malformed" };

  let record: WebhookAccountRecord;
  try {
    record = await deps.lookupAccount(claimed);
  } catch {
    return { ok: false, status: 503, reason: "twilio_account_lookup_failed" };
  }
  if (!record.found) return { ok: false, status: 403, reason: "twilio_account_unknown" };
  if (!deps.tokens) return { ok: false, status: 503, reason: "twilio_subaccount_verification_disabled" };

  let token: RedactedSecret;
  try {
    token = await deps.tokens.tokenFor(claimed);
  } catch {
    return { ok: false, status: 503, reason: "twilio_subaccount_token_unavailable" };
  }
  let verified = twilioSignatureMatches(token.reveal(), request, params);
  if (!verified) {
    // possibly a rotation since the token was cached: re-read once (spaced per account) and only retry with a token that actually changed
    let refreshed: { secret: RedactedSecret; changed: boolean };
    try {
      refreshed = await deps.tokens.refresh(claimed, token);
    } catch {
      return { ok: false, status: 503, reason: "twilio_subaccount_token_unavailable" };
    }
    verified = refreshed.changed && twilioSignatureMatches(refreshed.secret.reveal(), request, params);
  }
  if (!verified) return { ok: false, status: 403, reason: "twilio_signature_invalid" };

  const studioIds = record.studioIds.filter((id) => UUID.test(id));
  return { ok: true, account: { kind: "subaccount", accountSid: claimed, legalEntityId: record.legalEntityId, studioIds } };
}

/**
 * Tenant isolation after verification. The parent account is the platform itself (its credentials can already read every subaccount), so it may act
 * for any studio, exactly as before TW-4F. A subaccount may act only for the studios of its own legal business; a webhook that cannot be tied to a
 * studio (null) is never accepted from a subaccount.
 */
export function webhookMayActForStudio(account: VerifiedWebhookAccount, studioId: string | null): boolean {
  if (account.kind === "parent") return true;
  return studioId !== null && account.studioIds.includes(studioId);
}

/** Parses the tw4_webhook_account reply defensively: anything unexpected is "not ours". */
export function parseWebhookAccountRecord(raw: unknown): WebhookAccountRecord {
  const row = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (row.found !== true) return { found: false };
  const status = row.status;
  const entity = row.legal_entity_id;
  if ((status !== "active" && status !== "suspended") || typeof entity !== "string" || !UUID.test(entity)) return { found: false };
  const studioIds = Array.isArray(row.studio_ids) ? row.studio_ids.filter((id): id is string => typeof id === "string" && UUID.test(id)) : [];
  return { found: true, legalEntityId: entity, status, studioIds };
}

/** Replay-ledger key of a webhook event (null = not keyable, so no replay protection applies). Message SIDs only; never bodies or phone numbers. */
export function webhookReceiptKey(kind: "inbound" | "status", params: Record<string, string>): string | null {
  const sid = String(params.MessageSid ?? params.SmsSid ?? "").trim();
  if (!/^(SM|MM)[0-9a-fA-F]{32}$/.test(sid)) return null;
  if (kind === "inbound") return sid;
  const status = String(params.MessageStatus ?? params.SmsStatus ?? "").trim().toLowerCase();
  if (!/^[a-z_-]{1,40}$/.test(status)) return null;
  return `${sid}:${status}`;
}
