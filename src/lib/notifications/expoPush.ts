import { createAdminClient } from "@/lib/supabase/admin";

export type MobileNotificationCategory =
  | "schedule"
  | "event"
  | "favorites"
  | "learning"
  | "account"
  | "partner"
  | "system";

type PushTokenRow = {
  id: string;
  user_id: string;
  expo_push_token: string;
  enabled: boolean;
};

type PreferenceRow = {
  user_id: string;
  push_enabled: boolean;
  schedule_updates: boolean;
  event_updates: boolean;
  favorite_updates: boolean;
  learning_updates: boolean;
  account_updates: boolean;
  partner_updates: boolean;
};

type ExpoPushResult = {
  status?: string;
  id?: string;
  message?: string;
  details?: {
    error?: string;
  };
};

type SendMobilePushParams = {
  userId: string;
  category: MobileNotificationCategory;
  title: string;
  body?: string | null;
  data?: Record<string, unknown>;
};

const EXPO_PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send";

function preferenceColumnForCategory(category: MobileNotificationCategory) {
  switch (category) {
    case "schedule":
      return "schedule_updates";
    case "event":
      return "event_updates";
    case "favorites":
      return "favorite_updates";
    case "learning":
      return "learning_updates";
    case "partner":
      return "partner_updates";
    case "account":
    case "system":
    default:
      return "account_updates";
  }
}

function cleanString(value: string, fallback: string) {
  const trimmed = value.trim();
  return trimmed || fallback;
}

async function writeMobileNotificationLog(params: {
  userId: string;
  category: MobileNotificationCategory;
  title: string;
  body?: string | null;
  data?: Record<string, unknown>;
  status: "sent" | "failed" | "skipped";
  providerMessageId?: string | null;
  errorMessage?: string | null;
}) {
  const supabase = createAdminClient();

  await supabase.from("mobile_notification_log").insert({
    user_id: params.userId,
    category: params.category,
    title: params.title,
    body: params.body ?? null,
    data: params.data ?? {},
    status: params.status,
    provider_message_id: params.providerMessageId ?? null,
    error_message: params.errorMessage ?? null,
    sent_at: params.status === "sent" ? new Date().toISOString() : null,
  });
}

async function getUserPreference(userId: string) {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("mobile_notification_preferences")
    .select(
      "user_id, push_enabled, schedule_updates, event_updates, favorite_updates, learning_updates, account_updates, partner_updates"
    )
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load mobile notification preferences: ${error.message}`);
  }

  return data as PreferenceRow | null;
}

async function getEnabledPushTokens(userId: string) {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("mobile_push_tokens")
    .select("id, user_id, expo_push_token, enabled")
    .eq("user_id", userId)
    .eq("enabled", true);

  if (error) {
    throw new Error(`Failed to load mobile push tokens: ${error.message}`);
  }

  return (data ?? []) as PushTokenRow[];
}

async function markTokenInactive(token: string) {
  const supabase = createAdminClient();

  await supabase
    .from("mobile_push_tokens")
    .update({
      enabled: false,
      updated_at: new Date().toISOString(),
    })
    .eq("expo_push_token", token);
}

function normalizeExpoResponse(value: unknown): ExpoPushResult[] {
  const maybeData =
    value && typeof value === "object" && "data" in value
      ? (value as { data?: unknown }).data
      : value;

  if (Array.isArray(maybeData)) {
    return maybeData as ExpoPushResult[];
  }

  if (maybeData && typeof maybeData === "object") {
    return [maybeData as ExpoPushResult];
  }

  return [];
}

export async function sendMobilePushToUser(params: SendMobilePushParams) {
  const userId = cleanString(params.userId, "");
  const title = cleanString(params.title, "DanceFlow");
  const body = params.body?.trim() || null;
  const category = params.category;
  const data = {
    ...(params.data ?? {}),
    category,
  };

  if (!userId) {
    throw new Error("A dancer account is required.");
  }

  const preference = await getUserPreference(userId);
  const preferenceColumn = preferenceColumnForCategory(category);

  if (preference && (!preference.push_enabled || !preference[preferenceColumn])) {
    await writeMobileNotificationLog({
      userId,
      category,
      title,
      body,
      data,
      status: "skipped",
      errorMessage: "This dancer has turned off this notification type.",
    });

    return {
      ok: true,
      status: "skipped" as const,
      sent: 0,
      failed: 0,
      message: "This dancer has turned off this notification type.",
    };
  }

  const tokens = await getEnabledPushTokens(userId);

  if (tokens.length === 0) {
    await writeMobileNotificationLog({
      userId,
      category,
      title,
      body,
      data,
      status: "skipped",
      errorMessage: "No active mobile device is registered for this dancer.",
    });

    return {
      ok: true,
      status: "skipped" as const,
      sent: 0,
      failed: 0,
      message: "No active mobile device is registered for this dancer.",
    };
  }

  const messages = tokens.map((token) => ({
    to: token.expo_push_token,
    sound: "default",
    title,
    body: body ?? undefined,
    data,
  }));

  const response = await fetch(EXPO_PUSH_ENDPOINT, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Accept-encoding": "gzip, deflate",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(messages),
  });

  const responseBody = await response.json().catch(() => null);

  if (!response.ok) {
    const errorMessage =
      responseBody && typeof responseBody === "object" && "errors" in responseBody
        ? JSON.stringify((responseBody as { errors?: unknown }).errors)
        : `Expo push request failed with status ${response.status}.`;

    await writeMobileNotificationLog({
      userId,
      category,
      title,
      body,
      data,
      status: "failed",
      errorMessage,
    });

    return {
      ok: false,
      status: "failed" as const,
      sent: 0,
      failed: tokens.length,
      message: errorMessage,
    };
  }

  const expoResults = normalizeExpoResponse(responseBody);
  let sent = 0;
  let failed = 0;
  let providerMessageId: string | null = null;
  const errorMessages: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const result = expoResults[index];

    if (result?.status === "ok") {
      sent += 1;
      providerMessageId = providerMessageId || result.id || null;
      continue;
    }

    failed += 1;

    const errorMessage =
      result?.message ||
      result?.details?.error ||
      "Expo reported that this push message was not accepted.";

    errorMessages.push(errorMessage);

    if (result?.details?.error === "DeviceNotRegistered") {
      await markTokenInactive(token.expo_push_token);
    }
  }

  await writeMobileNotificationLog({
    userId,
    category,
    title,
    body,
    data,
    status: sent > 0 ? "sent" : "failed",
    providerMessageId,
    errorMessage: errorMessages.length ? errorMessages.join(" | ") : null,
  });

  return {
    ok: sent > 0,
    status: sent > 0 ? ("sent" as const) : ("failed" as const),
    sent,
    failed,
    message:
      sent > 0
        ? `Sent to ${sent} device${sent === 1 ? "" : "s"}.`
        : errorMessages[0] || "No push notifications were sent.",
  };
}
