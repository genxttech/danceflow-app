import { Resend } from "resend";

/**
 * Marketing M-0: one provider call for a marketing message, with its outcome classified for the send-attempt lifecycle.
 *
 *   sent      the provider accepted the message (it returned a message id)
 *   rejected  the provider definitively refused THIS message (validation): record failed, never retry automatically
 *   not_sent  the provider definitively did not accept it for a reason that is not about this recipient (rate limit,
 *             quota, credentials, sender configuration): safe to try later; the batch stops
 *   uncertain no definitive answer (network error, timeout, 5xx, idempotency conflict): the message MAY have been
 *             accepted. The recipient stays claimed and is retried later with the same idempotency key, which the
 *             provider de-duplicates within its retention window. Exactly-once delivery is not claimed.
 */

export type MarketingProviderOutcome =
  | { kind: "sent"; messageId: string }
  | { kind: "rejected"; code: string }
  | { kind: "not_sent"; code: string }
  | { kind: "uncertain"; code: string };

export type MarketingEmailMessage = {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string | null;
  headers: Record<string, string>;
  idempotencyKey: string;
};

type ResendLikeError = { name?: string | null; message?: string | null; statusCode?: number | null } | null | undefined;
type ResendLikeResult = { data?: { id?: unknown } | null; error?: ResendLikeError };

export type MarketingEmailTransport = {
  send: (
    payload: {
      from: string;
      to: string[];
      subject: string;
      html: string;
      text: string;
      replyTo?: string;
      headers: Record<string, string>;
    },
    options: { idempotencyKey: string },
  ) => Promise<ResendLikeResult>;
};

const REJECTED = new Set(["validation_error", "invalid_parameter", "missing_required_field", "invalid_attachment"]);

const NOT_SENT = new Set([
  "missing_api_key",
  "restricted_api_key",
  "invalid_api_key",
  "invalid_from_address",
  "invalid_access",
  "invalid_region",
  "monthly_quota_exceeded",
  "daily_quota_exceeded",
  "rate_limit_exceeded",
  "security_error",
  "not_found",
  "method_not_allowed",
  "invalid_idempotency_key",
]);

/** Provider error -> lifecycle outcome. Anything unrecognized is uncertain (never assumed "not sent"). */
export function classifyProviderError(error: ResendLikeError): MarketingProviderOutcome {
  const code = String(error?.name ?? "").trim() || "unknown_error";
  if (REJECTED.has(code)) return { kind: "rejected", code };
  if (NOT_SENT.has(code)) return { kind: "not_sent", code };
  return { kind: "uncertain", code };
}

export function createResendMarketingTransport(apiKey = process.env.RESEND_API_KEY): MarketingEmailTransport {
  if (!apiKey) throw new Error("Missing RESEND_API_KEY.");
  const resend = new Resend(apiKey);
  return {
    send: (payload, options) => resend.emails.send(payload, options) as Promise<ResendLikeResult>,
  };
}

export async function sendMarketingEmail(
  transport: MarketingEmailTransport,
  message: MarketingEmailMessage,
): Promise<MarketingProviderOutcome> {
  try {
    const result = await transport.send(
      {
        from: message.from,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        headers: message.headers,
      },
      { idempotencyKey: message.idempotencyKey },
    );
    if (result?.error) return classifyProviderError(result.error);
    const id = result?.data?.id;
    if (typeof id === "string" && id.trim()) return { kind: "sent", messageId: id };
    return { kind: "uncertain", code: "missing_message_id" };
  } catch {
    return { kind: "uncertain", code: "transport_error" };
  }
}
