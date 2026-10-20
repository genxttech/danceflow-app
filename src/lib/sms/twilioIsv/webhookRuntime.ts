import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseWebhookAccountRecord, type WebhookAccountDeps } from "@/lib/sms/twilioWebhookAccount";
import { SubaccountTokenProvider } from "./account";
import { fakeAdapterAllowed, subaccountWebhooksAllowed } from "./config";
import type { FakeIsvParent } from "./fake";
import { createWebhookTokenParent } from "./real";

/**
 * TW-4F provider integration: the production wiring of account-aware webhook verification. SERVER ONLY.
 *  - The account lookup is the service-role `tw4_webhook_account` function (ids and status only).
 *  - Tokens: production + TW4_SUBACCOUNT_WEBHOOKS=on -> on-demand reads through the parent credentials (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN),
 *    one process-wide short-lived cache; local fake mode (TW4_ISV_FAKE=on, local database) -> the in-memory fake parent's tokens; otherwise none,
 *    so a webhook naming one of our subaccounts is refused (403, reason code logged) and parent-signed webhooks are verified as before.
 */

/**
 * How long a subaccount token is reused for webhook verification. Short on purpose: after a rotation, a cached OLD token keeps verifying in a warm
 * instance until this expires (or a failed signature forces a re-read), so this bounds how long a leaked, rotated token stays useful.
 */
export const WEBHOOK_TOKEN_TTL_MS = 60_000;

const globalForWebhooks = globalThis as unknown as { __tw4WebhookTokens?: SubaccountTokenProvider; __tw4FakeIsvParent?: FakeIsvParent };

function tokenSource(env: Record<string, string | undefined>): WebhookAccountDeps["tokens"] {
  if (fakeAdapterAllowed(env)) {
    const fake = globalForWebhooks.__tw4FakeIsvParent;
    return fake ? new SubaccountTokenProvider(fake, { ttlMs: 0, refreshIntervalMs: 0 }) : null;
  }
  if (!subaccountWebhooksAllowed(env).allowed) return null;
  const accountSid = String(env.TWILIO_ACCOUNT_SID ?? "").trim();
  const authToken = String(env.TWILIO_AUTH_TOKEN ?? "").trim();
  try {
    return (globalForWebhooks.__tw4WebhookTokens ??= new SubaccountTokenProvider(createWebhookTokenParent({ accountSid, authToken }, env), { ttlMs: WEBHOOK_TOKEN_TTL_MS }));
  } catch {
    return null;
  }
}

export function buildWebhookAccountDeps(supabase: Pick<SupabaseClient, "rpc"> | null, env: Record<string, string | undefined> = process.env): WebhookAccountDeps {
  return {
    parentAccountSid: String(env.TWILIO_ACCOUNT_SID ?? "").trim(),
    lookupAccount: async (accountSid) => {
      if (!supabase) throw new Error("tw4_webhook_account:no_client");
      const { data, error } = (await supabase.rpc("tw4_webhook_account", { p_account_sid: accountSid })) as { data: unknown; error: { code?: string } | null };
      if (error) throw new Error(`tw4_webhook_account:${error.code ?? "unknown"}`);
      return parseWebhookAccountRecord(data);
    },
    tokens: tokenSource(env),
  };
}

/**
 * Replay ledger (sms_webhook_receipts): records the event and returns "first" for its first delivery, "duplicate" for any later one. "unavailable"
 * when the ledger cannot be reached: the caller then PROCESSES the event (fail open), because dropping a genuine STOP is worse than handling a
 * replayed one twice (every consent and status effect is idempotent; the signature has already been verified).
 */
export async function recordWebhookReceipt(
  supabase: Pick<SupabaseClient, "rpc">, kind: "inbound" | "status", key: string, accountSid: string | null,
): Promise<"first" | "duplicate" | "unavailable"> {
  try {
    const { data, error } = (await supabase.rpc("sms_webhook_receipt_record", { p_kind: kind, p_event_key: key, p_account_sid: accountSid })) as { data: unknown; error: { code?: string } | null };
    if (error) return "unavailable";
    return data === true ? "first" : data === false ? "duplicate" : "unavailable";
  } catch {
    return "unavailable";
  }
}
