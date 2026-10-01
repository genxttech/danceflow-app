import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

/**
 * LAUNCH-SEC-1B: client photos are served only through short-lived signed URLs
 * created on the server for an authorized studio/client, so the
 * `client-photos` bucket can be made private without breaking rendering.
 *
 * `clients.photo_url` holds either the legacy public URL for this project's
 * bucket or (for new uploads) the bare object path
 * `{studioId}/{clientId}/{timestamp}-{uuid}.{ext}`. Both resolve to the same
 * object path and are signed the same way. Anything else is rejected; a value
 * is never normalized into an accepted one. There is deliberately no endpoint
 * or action that signs a browser-supplied path.
 */

export const CLIENT_PHOTO_BUCKET = "client-photos";
export const CLIENT_PHOTO_SIGNED_URL_TTL_SECONDS = 600;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const OBJECT_PATH_PATTERN = new RegExp(
  `^(${UUID})/(${UUID})/[0-9]{13}-${UUID}\\.(?:jpg|jpeg|png|webp)$`,
);
const URL_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;
const MAX_STORED_LENGTH = 512;

export type ClientPhotoObjectPath = {
  path: string;
  studioId: string;
  clientId: string;
};

function legacyPublicUrlPrefix() {
  const configured = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!configured) return null;

  try {
    const url = new URL(configured);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return `${url.origin}/storage/v1/object/public/${CLIENT_PHOTO_BUCKET}/`;
  } catch {
    return null;
  }
}

export function parseClientPhotoObjectPath(stored: unknown): ClientPhotoObjectPath | null {
  if (typeof stored !== "string" || stored.length === 0 || stored.length > MAX_STORED_LENGTH) {
    return null;
  }

  let candidate = stored;
  if (URL_SCHEME_PATTERN.test(stored)) {
    const prefix = legacyPublicUrlPrefix();
    if (!prefix || !stored.startsWith(prefix)) return null;
    candidate = stored.slice(prefix.length);
  }

  // The pattern admits only lowercase hex, digits, '-', '/', '.' and the
  // extension, so '..', '%', '?', '#', '\\' and whitespace can never match.
  const match = OBJECT_PATH_PATTERN.exec(candidate);
  if (!match) return null;

  return { path: candidate, studioId: match[1], clientId: match[2] };
}

export async function createClientPhotoSignedUrl(
  stored: unknown,
  scope: { studioId: string; clientId: string },
): Promise<string | null> {
  const parsed = parseClientPhotoObjectPath(stored);
  if (!parsed) return null;

  if (parsed.studioId !== scope.studioId || parsed.clientId !== scope.clientId) {
    console.warn("client_photo_scope_mismatch");
    return null;
  }

  try {
    const admin = createAdminClient();
    const { data, error } = await admin.storage
      .from(CLIENT_PHOTO_BUCKET)
      .createSignedUrl(parsed.path, CLIENT_PHOTO_SIGNED_URL_TTL_SECONDS);

    if (error || !data?.signedUrl) {
      console.warn("client_photo_sign_failed");
      return null;
    }

    return data.signedUrl;
  } catch {
    console.warn("client_photo_sign_failed");
    return null;
  }
}
