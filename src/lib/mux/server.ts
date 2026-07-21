import "server-only";

import { createHmac, timingSafeEqual } from "crypto";

const MUX_API_BASE = "https://api.mux.com/video/v1";

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing ${name}.`);
  }
  return value;
}

function muxAuthorization() {
  const tokenId = required("MUX_TOKEN_ID");
  const tokenSecret = required("MUX_TOKEN_SECRET");
  return `Basic ${Buffer.from(`${tokenId}:${tokenSecret}`).toString("base64")}`;
}

async function muxRequest<T>(
  path: string,
  init: RequestInit,
): Promise<T> {
  const response = await fetch(`${MUX_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: muxAuthorization(),
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    cache: "no-store",
  });

  const payload = (await response.json().catch(() => null)) as
    | { data?: T; error?: { messages?: string[]; message?: string } }
    | null;

  if (!response.ok || !payload?.data) {
    const message =
      payload?.error?.messages?.join(", ") ||
      payload?.error?.message ||
      `Mux request failed with status ${response.status}.`;
    throw new Error(message);
  }

  return payload.data;
}

export type MuxDirectUpload = {
  id: string;
  url: string;
  status: string;
  asset_id?: string | null;
};

export async function createMuxDirectUpload(input: {
  corsOrigin: string;
  passthrough: string;
}) {
  return muxRequest<MuxDirectUpload>("/uploads", {
    method: "POST",
    body: JSON.stringify({
      cors_origin: input.corsOrigin,
      timeout: 3600,
      new_asset_settings: {
        playback_policies: ["signed"],
        video_quality: "basic",
        passthrough: input.passthrough,
      },
    }),
  });
}

export function verifyMuxWebhookSignature(input: {
  rawBody: string;
  signatureHeader: string | null;
  toleranceSeconds?: number;
}) {
  const secret = required("MUX_WEBHOOK_SECRET");
  const tolerance = input.toleranceSeconds ?? 300;
  const parts = new Map(
    (input.signatureHeader ?? "")
      .split(",")
      .map((part) => part.trim().split("=", 2) as [string, string]),
  );

  const timestamp = parts.get("t");
  const supplied = parts.get("v1");

  if (!timestamp || !supplied || !/^\d+$/.test(timestamp)) {
    return false;
  }

  const timestampNumber = Number(timestamp);
  const now = Math.floor(Date.now() / 1000);

  if (
    !Number.isFinite(timestampNumber) ||
    Math.abs(now - timestampNumber) > tolerance
  ) {
    return false;
  }

  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.${input.rawBody}`)
    .digest("hex");

  const expectedBuffer = Buffer.from(expected, "hex");
  const suppliedBuffer = Buffer.from(supplied, "hex");

  return (
    expectedBuffer.length === suppliedBuffer.length &&
    timingSafeEqual(expectedBuffer, suppliedBuffer)
  );
}

export function getMuxSigningPrivateKey() {
  const base64 = process.env.MUX_SIGNING_PRIVATE_KEY_BASE64?.trim();
  if (base64) {
    return Buffer.from(base64, "base64").toString("utf8");
  }

  return required("MUX_SIGNING_PRIVATE_KEY").replace(/\\n/g, "\n");
}

export function getMuxSigningKeyId() {
  return required("MUX_SIGNING_KEY_ID");
}
