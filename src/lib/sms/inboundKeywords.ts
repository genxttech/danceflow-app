/**
 * TW-1: inbound SMS compliance-keyword classification.
 *
 * Twilio Advanced Opt-Out is the authority for STOP/START/HELP. Every studio Messaging
 * Service must have Advanced Opt-Out enabled, with its keywords and confirmation replies
 * configured to match that studio's campaign submission. When it handles a keyword, Twilio
 * has already blocked/unblocked the recipient and sent the configured reply, and it adds
 * `OptOutType` (STOP | START | HELP) to the inbound webhook. The application then only
 * records the event locally and must not send a second compliance reply.
 *
 * Without `OptOutType` (Advanced Opt-Out missing or misconfigured on that service), the
 * exact-message fallback below mirrors Twilio's standard English keywords. Matching is
 * whole-message and case-insensitive: "please stop texting" is an ordinary message.
 */

export type InboundKeyword = "stop" | "start" | "help" | "message";

export type InboundKeywordResolution = {
  keyword: InboundKeyword;
  /** True when Twilio Advanced Opt-Out handled the keyword and already replied. */
  twilioHandled: boolean;
};

/** Twilio's standard English opt-out keywords for long codes. */
export const SMS_FALLBACK_OPT_OUT_KEYWORDS: ReadonlySet<string> = new Set([
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT",
  "REVOKE",
  "OPTOUT",
]);

/** START and UNSTOP are Twilio-reserved; YES is Twilio's standard opt-in alias. */
export const SMS_FALLBACK_OPT_IN_KEYWORDS: ReadonlySet<string> = new Set(["START", "YES", "UNSTOP"]);

export const SMS_FALLBACK_HELP_KEYWORDS: ReadonlySet<string> = new Set(["HELP", "INFO"]);

function optOutTypeKeyword(optOutType: string | null | undefined): InboundKeyword | null {
  const normalized = String(optOutType ?? "").trim().toUpperCase();

  if (normalized === "STOP") return "stop";
  if (normalized === "START") return "start";
  if (normalized === "HELP") return "help";

  return null;
}

export function classifyInboundKeywordBody(body: string): InboundKeyword {
  const normalized = String(body ?? "").trim().toUpperCase();

  if (SMS_FALLBACK_OPT_OUT_KEYWORDS.has(normalized)) return "stop";
  if (SMS_FALLBACK_OPT_IN_KEYWORDS.has(normalized)) return "start";
  if (SMS_FALLBACK_HELP_KEYWORDS.has(normalized)) return "help";

  return "message";
}

/**
 * A recognized `OptOutType` always wins over the message body (Twilio may be configured
 * with keywords the fallback list does not contain, and its block state is what carriers
 * enforce). An absent or unrecognized value falls back to exact-message parsing.
 */
export function resolveInboundKeyword(input: {
  optOutType?: string | null;
  body: string;
}): InboundKeywordResolution {
  const fromTwilio = optOutTypeKeyword(input.optOutType);

  if (fromTwilio) {
    return { keyword: fromTwilio, twilioHandled: true };
  }

  return { keyword: classifyInboundKeywordBody(input.body), twilioHandled: false };
}
