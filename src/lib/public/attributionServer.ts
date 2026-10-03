import "server-only";

import { cookies } from "next/headers";
import {
  ATTRIBUTION_COOKIE_NAME,
  attributionUserMetadata,
  parseAttributionCookie,
} from "@/lib/public/attribution";

/**
 * BR-4C: server-side read of the first-touch attribution cookie, for signup only.
 * The cookie is client-controlled, so it is re-validated on every read; anything invalid
 * yields no attribution and signup proceeds exactly as it did before.
 */
export async function readSignupAttributionMetadata(): Promise<Record<string, string>> {
  try {
    const store = await cookies();
    return attributionUserMetadata(parseAttributionCookie(store.get(ATTRIBUTION_COOKIE_NAME)?.value));
  } catch {
    return {};
  }
}
