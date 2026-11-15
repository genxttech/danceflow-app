import { staffErrorKind } from "@/lib/staffApi";

/**
 * A failed pull-to-refresh on a screen that already has data should not throw that data away. Only a transient failure (an outage or no connection) keeps it:
 * a refused session, role or studio is an answer, and the screen has to show it, not stale numbers. A first load or a date change has nothing to keep.
 */
export function shouldKeepStale(params: { enabled: boolean; mode: "initial" | "refresh"; hadData: boolean; error: unknown }) {
  return params.enabled && params.mode === "refresh" && params.hadData && staffErrorKind(params.error) === "unavailable";
}
