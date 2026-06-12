import {
  getSmsSendingUnavailableMessage,
  isSmsSendingApproved,
  normalizeSmsPhone,
} from "@/lib/sms/compliance";

export type TwilioSendSmsInput = {
  to: string;
  body: string;
  statusCallbackUrl?: string | null;
};

export type TwilioSendSmsResult = {
  ok: boolean;
  sid?: string;
  status?: string;
  error?: string;
  errorCode?: string;
};

function cleanEnv(value: string | undefined) {
  return String(value ?? "").trim();
}

function getTwilioConfig() {
  const messagingServiceSid =
    cleanEnv(process.env.TWILIO_MESSAGING_SERVICE_SID) ||
    cleanEnv(process.env.TWILIO_MESSAGE_SERVICE_SID);

  return {
    accountSid: cleanEnv(process.env.TWILIO_ACCOUNT_SID),
    authToken: cleanEnv(process.env.TWILIO_AUTH_TOKEN),
    messagingServiceSid,
  };
}

export function getTwilioMissingConfigKeys() {
  const config = getTwilioConfig();
  const missing: string[] = [];

  if (!config.accountSid) missing.push("TWILIO_ACCOUNT_SID");
  if (!config.authToken) missing.push("TWILIO_AUTH_TOKEN");
  if (!config.messagingServiceSid) {
    missing.push("TWILIO_MESSAGING_SERVICE_SID or TWILIO_MESSAGE_SERVICE_SID");
  }

  return missing;
}

export function isTwilioConfigured() {
  return getTwilioMissingConfigKeys().length === 0;
}

export function estimateSmsSegments(message: string) {
  const text = message.trim();

  if (!text) return 0;

  const hasUnicode = /[^\u0000-\u007f]/.test(text);
  const singleLimit = hasUnicode ? 70 : 160;
  const multipartLimit = hasUnicode ? 67 : 153;

  if (text.length <= singleLimit) return 1;

  return Math.ceil(text.length / multipartLimit);
}

export async function sendTwilioSms(input: TwilioSendSmsInput): Promise<TwilioSendSmsResult> {
  const config = getTwilioConfig();
  const missingConfigKeys = getTwilioMissingConfigKeys();
  const normalizedTo = normalizeSmsPhone(input.to);

  if (!normalizedTo) {
    return { ok: false, error: "Enter a valid phone number before sending a text." };
  }

  if (missingConfigKeys.length > 0) {
    return {
      ok: false,
      error: `Text messaging is not configured yet. Missing: ${missingConfigKeys.join(", ")}`,
      errorCode: "twilio_config_missing",
    };
  }

  if (!isSmsSendingApproved()) {
    return {
      ok: false,
      error: getSmsSendingUnavailableMessage(),
      errorCode: "sms_not_approved",
    };
  }

  const body = input.body.trim();

  if (!body) {
    return { ok: false, error: "Enter a message before sending a text." };
  }

  const params = new URLSearchParams();
  params.set("To", normalizedTo);
  params.set("MessagingServiceSid", config.messagingServiceSid);
  params.set("Body", body);

  if (input.statusCallbackUrl) {
    params.set("StatusCallback", input.statusCallbackUrl);
  }

  const response = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString(
          "base64",
        )}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
      cache: "no-store",
    },
  );

  const payload = (await response.json().catch(() => null)) as
    | {
        sid?: string;
        status?: string;
        message?: string;
        code?: string | number;
      }
    | null;

  if (!response.ok) {
    return {
      ok: false,
      error: payload?.message ?? "The text message could not be sent.",
      errorCode: payload?.code ? String(payload.code) : undefined,
    };
  }

  return {
    ok: true,
    sid: payload?.sid,
    status: payload?.status ?? "queued",
  };
}

export function mapTwilioStatusToSmsLogStatus(status: string | null | undefined) {
  const normalized = String(status ?? "").toLowerCase();

  if (normalized === "delivered") return "delivered";
  if (normalized === "failed" || normalized === "undelivered") return "failed";
  if (normalized === "sent") return "sent";
  if (normalized === "received") return "received";

  return "queued";
}