"use client";

import { useEffect } from "react";
import { ATTRIBUTION_COOKIE_NAME, decideAttributionCapture } from "@/lib/public/attribution";

function readCookie(name: string) {
  const prefix = `${name}=`;
  for (const part of document.cookie.split("; ")) {
    if (part.startsWith(prefix)) return part.slice(prefix.length);
  }
  return null;
}

/**
 * BR-4C: one reusable capture point, mounted once in the shared public header so every public
 * entry page (home, /for-*, /discover, studio and event pages, signup) records first-touch
 * campaign attribution without page-specific code. Renders nothing, calls no network, sets at
 * most one first-party cookie, and never touches localStorage. See `@/lib/public/attribution`
 * for the exact rules.
 */
export default function AttributionCapture() {
  useEffect(() => {
    try {
      const decision = decideAttributionCapture({
        search: window.location.search,
        existingCookieValue: readCookie(ATTRIBUTION_COOKIE_NAME),
        secure: window.location.protocol === "https:",
      });

      if (decision.action === "set") {
        document.cookie = decision.cookie;
      }
    } catch {
      // Attribution is best-effort and must never affect the page.
    }
  }, []);

  return null;
}
