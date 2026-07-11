import { NextResponse } from "next/server";

export const BOT_HONEYPOT_FIELD = "df_website";
export const BOT_STARTED_AT_FIELD = "df_started_at";
export const BOT_TURNSTILE_FIELD = "cf-turnstile-response";

const DEFAULT_MIN_SUBMIT_AGE_MS = 1_200;
const DEFAULT_MAX_SUBMIT_AGE_MS = 24 * 60 * 60 * 1000;

const AUTOMATED_USER_AGENT_PATTERN =
  /(?:\bbot\b|crawler|spider|scrapy|curl|wget|python-requests|python-httpx|httpclient|go-http-client|java\/|libwww-perl|nikto|sqlmap|masscan|nmap|zgrab|headlesschrome|phantomjs)/i;

const CONTACT_OR_LINK_PATTERN =
  /(https?:\/\/|www\.|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\b(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}\b)/i;

const EXCESSIVE_REPETITION_PATTERN = /(.)\1{24,}/;

export type BotProtectionResult = {
  allowed: boolean;
  message?: string;
};

export function getBotFieldValues() {
  return {
    honeypotField: BOT_HONEYPOT_FIELD,
    startedAtField: BOT_STARTED_AT_FIELD,
    startedAt: String(Date.now()),
  };
}

function formString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export function checkHoneypotAndSubmitTime(
  formData: FormData,
  options: {
    minAgeMs?: number;
    maxAgeMs?: number;
    missingTimestampAllowed?: boolean;
  } = {},
): BotProtectionResult {
  const honeypotValue = formString(formData, BOT_HONEYPOT_FIELD);

  if (honeypotValue) {
    return {
      allowed: false,
      message: "Submission could not be processed. Please refresh and try again.",
    };
  }

  const startedAtRaw = formString(formData, BOT_STARTED_AT_FIELD);

  if (!startedAtRaw) {
    return options.missingTimestampAllowed
      ? { allowed: true }
      : {
          allowed: false,
          message: "Please refresh the page and submit the form again.",
        };
  }

  const startedAt = Number(startedAtRaw);

  if (!Number.isFinite(startedAt) || startedAt <= 0) {
    return {
      allowed: false,
      message: "Please refresh the page and submit the form again.",
    };
  }

  const ageMs = Date.now() - startedAt;
  const minAgeMs = options.minAgeMs ?? DEFAULT_MIN_SUBMIT_AGE_MS;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_SUBMIT_AGE_MS;

  if (ageMs < minAgeMs) {
    return {
      allowed: false,
      message: "Submission could not be processed. Please wait a moment and try again.",
    };
  }

  if (ageMs > maxAgeMs) {
    return {
      allowed: false,
      message: "This form has expired. Please refresh the page and submit again.",
    };
  }

  return { allowed: true };
}

export async function checkOptionalTurnstile(
  formData: FormData,
  remoteIp?: string | null,
): Promise<BotProtectionResult> {
  const secret = process.env.TURNSTILE_SECRET_KEY;

  if (!secret) {
    return { allowed: true };
  }

  const token = formString(formData, BOT_TURNSTILE_FIELD);

  if (!token) {
    return {
      allowed: false,
      message: "Please complete the verification challenge and try again.",
    };
  }

  const verificationBody = new URLSearchParams();
  verificationBody.set("secret", secret);
  verificationBody.set("response", token);
  if (remoteIp) verificationBody.set("remoteip", remoteIp);

  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: verificationBody,
    });

    if (!response.ok) {
      return {
        allowed: false,
        message: "Verification could not be completed. Please try again.",
      };
    }

    const payload = (await response.json().catch(() => null)) as { success?: boolean } | null;

    if (!payload?.success) {
      return {
        allowed: false,
        message: "Verification failed. Please try again.",
      };
    }

    return { allowed: true };
  } catch {
    return {
      allowed: false,
      message: "Verification could not be completed. Please try again.",
    };
  }
}

export async function checkPublicFormProtection(
  formData: FormData,
  options: {
    minAgeMs?: number;
    maxAgeMs?: number;
    missingTimestampAllowed?: boolean;
    remoteIp?: string | null;
  } = {},
): Promise<BotProtectionResult> {
  const passiveCheck = checkHoneypotAndSubmitTime(formData, options);
  if (!passiveCheck.allowed) return passiveCheck;

  return checkOptionalTurnstile(formData, options.remoteIp);
}

export function containsExternalContactOrLink(value: string) {
  return CONTACT_OR_LINK_PATTERN.test(value);
}

export function looksLikeMessageAbuse(value: string) {
  const normalized = value.trim();
  if (normalized.length < 2) return true;
  if (EXCESSIVE_REPETITION_PATTERN.test(normalized)) return true;

  const linkMatches = normalized.match(/https?:\/\/|www\./gi) ?? [];
  return linkMatches.length > 1;
}

export function isLikelyAutomatedUserAgent(userAgent: string | null | undefined) {
  const normalized = (userAgent ?? "").trim();
  if (!normalized) return true;
  return AUTOMATED_USER_AGENT_PATTERN.test(normalized);
}

export function requestLooksAutomated(request: Request) {
  return isLikelyAutomatedUserAgent(request.headers.get("user-agent"));
}

export function botBlockedJson(headers?: HeadersInit) {
  return NextResponse.json(
    { error: "Resource not found." },
    {
      status: 404,
      headers: {
        ...headers,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
