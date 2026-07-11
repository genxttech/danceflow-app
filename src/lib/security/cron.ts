import { timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";

type CronSecretValue = string | null | undefined;

type CronAuthOptions = {
  secrets?: CronSecretValue[];
};

function normalizeSecret(value: CronSecretValue) {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function extractBearerToken(headerValue: string | null) {
  if (!headerValue) return null;

  const match = headerValue.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export function getCronSecretFromRequest(request: Request) {
  return (
    extractBearerToken(request.headers.get("authorization")) ||
    request.headers.get("x-cron-secret")?.trim() ||
    null
  );
}

export function hasValidSecret(
  providedSecret: string | null | undefined,
  expectedSecret: string | null | undefined,
) {
  const provided = normalizeSecret(providedSecret);
  const expected = normalizeSecret(expectedSecret);

  if (!provided || !expected) return false;

  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);

  if (providedBuffer.length !== expectedBuffer.length) return false;

  return timingSafeEqual(providedBuffer, expectedBuffer);
}

export function isAuthorizedCronRequest(
  request: Request,
  options: CronAuthOptions = {},
) {
  const provided = getCronSecretFromRequest(request);
  const configuredSecrets =
    options.secrets && options.secrets.length > 0
      ? options.secrets
      : [process.env.CRON_SECRET];

  return configuredSecrets.some((secret) => hasValidSecret(provided, secret));
}

export function getCronAuthFailure(
  request: Request,
  options: CronAuthOptions = {},
) {
  const configuredSecrets =
    options.secrets && options.secrets.length > 0
      ? options.secrets
      : [process.env.CRON_SECRET];

  const hasConfiguredSecret = configuredSecrets.some((secret) =>
    Boolean(normalizeSecret(secret)),
  );

  if (!hasConfiguredSecret) {
    return NextResponse.json(
      { ok: false, error: "Cron authentication is not configured." },
      {
        status: 503,
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  }

  if (!isAuthorizedCronRequest(request, { secrets: configuredSecrets })) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized" },
      {
        status: 401,
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  }

  return null;
}
