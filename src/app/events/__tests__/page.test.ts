import { describe, expect, it } from "vitest";
import EventsRedirectPage from "../page";

/**
 * Regression coverage for the confirmed Public Event Registration
 * `/events` -> `/discover/events` query-string-loss defect: `/events`
 * redirected unconditionally, dropping every query parameter -- including
 * an `error=...`/`success=...` a caller like
 * `/api/events/cart/resume-after-signing` was counting on
 * `/discover/events` to still see. Fixed by forwarding the full query
 * string onto the same, hardcoded `/discover/events` destination.
 *
 * `redirect()` is not mocked here -- these tests catch the real,
 * unmodified `next/navigation` `redirect()` throw and assert on its real
 * `NEXT_REDIRECT`-shaped digest, so they fail if the real Next.js redirect
 * mechanism or destination ever changes, not just this file's own logic.
 */
async function capturedRedirectDestination(
  query: Record<string, string | string[] | undefined>,
): Promise<string> {
  try {
    await EventsRedirectPage({ searchParams: Promise.resolve(query) });
  } catch (error) {
    const digest = (error as { digest?: string })?.digest ?? "";
    const match = digest.match(/^NEXT_REDIRECT;[^;]+;(.*);\d+;?$/);
    if (match) return match[1];
    throw error;
  }
  throw new Error("Expected EventsRedirectPage to redirect, but it returned normally.");
}

describe("EventsRedirectPage", () => {
  it("preserves a single error query parameter", async () => {
    const destination = await capturedRedirectDestination({ error: "checkout_resume_failed" });
    expect(destination).toBe("/discover/events?error=checkout_resume_failed");
  });

  it("preserves multiple query parameters together", async () => {
    const destination = await capturedRedirectDestination({
      error: "checkout_resume_failed",
      order: "abc-123",
    });
    const url = new URL(destination, "http://localhost");
    expect(url.pathname).toBe("/discover/events");
    expect(url.searchParams.get("error")).toBe("checkout_resume_failed");
    expect(url.searchParams.get("order")).toBe("abc-123");
  });

  it("redirects bare /events (no query parameters) to /discover/events with no trailing '?'", async () => {
    const destination = await capturedRedirectDestination({});
    expect(destination).toBe("/discover/events");
  });

  it("preserves a success query parameter", async () => {
    const destination = await capturedRedirectDestination({ success: "registration_complete" });
    expect(destination).toBe("/discover/events?success=registration_complete");
  });
});
