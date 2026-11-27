import { describe, expect, it } from "vitest";
import { escapeIcsText, etagFor, foldIcsLine, renderCalendar, sequenceFromUpdatedAt, type FeedEvent } from "../ics";
import { FEED_SECRET_PATTERN, generateFeedSecret, hashFeedSecret, parseFeedSecret } from "../token";

const event = (over: Partial<FeedEvent> = {}): FeedEvent => ({
  uid: "abc-123@danceflow",
  summary: "Private lesson",
  startsAt: "2026-12-01T18:00:00.000Z",
  endsAt: "2026-12-01T19:00:00.000Z",
  status: "CONFIRMED",
  sequence: 10,
  lastModified: "2026-11-20T10:00:00.000Z",
  ...over,
});

describe("feed secrets", () => {
  it("generates 43-char base64url secrets whose hash is SHA-256 hex and never equals the secret", () => {
    const { secret, hash, prefix } = generateFeedSecret();
    expect(secret).toMatch(FEED_SECRET_PATTERN);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashFeedSecret(secret));
    expect(hash).not.toContain(secret);
    expect(secret.startsWith(prefix)).toBe(true);
    expect(generateFeedSecret().secret).not.toBe(secret);
  });

  it("parses only exactly-shaped secrets, with or without .ics", () => {
    const { secret } = generateFeedSecret();
    expect(parseFeedSecret(secret)).toBe(secret);
    expect(parseFeedSecret(`${secret}.ics`)).toBe(secret);
    expect(parseFeedSecret(`${secret}.ICS`)).toBe(secret);
    for (const bad of ["", "short", `${secret}x`, `${secret.slice(1)}`, `${secret.slice(0, 42)}!`, "../etc/passwd", null, undefined]) {
      expect(parseFeedSecret(bad as string)).toBeNull();
    }
  });
});

describe("ICS rendering", () => {
  it("escapes TEXT and strips CR/LF and control-character injection", () => {
    const evil = "Hi\r\nEND:VEVENT\r\nBEGIN:VEVENT\nX:1;2,3\\ \u0000\u0007";
    const escaped = escapeIcsText(evil);
    expect(escaped).not.toMatch(/[\r\n\u0000\u0007]/);
    expect(escaped).toContain("\\n");
    expect(escaped).toContain("\\;");
    expect(escaped).toContain("\\,");
    const body = renderCalendar({ calendarName: "Cal\r\nX-EVIL:1", events: [event({ summary: evil })] });
    expect(body.split("\r\n").filter((l) => l.startsWith("END:VEVENT"))).toHaveLength(1);
    expect(body).not.toMatch(/\nX-EVIL/);
  });

  it("folds at 75 octets without splitting multi-byte characters", () => {
    const line = "SUMMARY:" + "é".repeat(80) + "日本語".repeat(20);
    const folded = foldIcsLine(line);
    const encoder = new TextEncoder();
    for (const piece of folded.split("\r\n")) expect(encoder.encode(piece).length).toBeLessThanOrEqual(75);
    expect(folded.split("\r\n").map((p, i) => (i ? p.slice(1) : p)).join("")).toBe(line);
  });

  it("emits stable UID, SEQUENCE, STATUS and UTC instants; cancelled events keep the UID", () => {
    const live = renderCalendar({ calendarName: "Studio Schedule", events: [event()] });
    const cancelled = renderCalendar({ calendarName: "Studio Schedule", events: [event({ status: "CANCELLED", sequence: 11 })] });
    expect(live).toContain("UID:abc-123@danceflow");
    expect(live).toContain("SEQUENCE:10");
    expect(live).toContain("STATUS:CONFIRMED");
    expect(live).toContain("DTSTART:20261201T180000Z");
    expect(live).toContain("DTEND:20261201T190000Z");
    expect(cancelled).toContain("UID:abc-123@danceflow");
    expect(cancelled).toContain("STATUS:CANCELLED");
    expect(cancelled).toContain("SEQUENCE:11");
    expect(live.endsWith("\r\n")).toBe(true);
    expect(live).not.toMatch(/(^|[^\r])\n/);
  });

  it("is deterministic (stable body and ETag) and changes when content changes", () => {
    const a = renderCalendar({ calendarName: "S", events: [event(), event({ uid: "z@danceflow", startsAt: "2026-12-02T18:00:00.000Z" })] });
    const b = renderCalendar({ calendarName: "S", events: [event({ uid: "z@danceflow", startsAt: "2026-12-02T18:00:00.000Z" }), event()] });
    expect(a).toBe(b);
    expect(etagFor(a)).toBe(etagFor(b));
    expect(etagFor(a)).toMatch(/^"[0-9a-f]{32}"$/);
    const c = renderCalendar({ calendarName: "S", events: [event({ summary: "Changed" })] });
    expect(etagFor(c)).not.toBe(etagFor(a));
  });

  it("derives a monotonic non-negative SEQUENCE from updated_at", () => {
    const early = sequenceFromUpdatedAt("2026-11-01T00:00:00Z");
    const later = sequenceFromUpdatedAt("2026-11-01T00:00:05Z");
    expect(later - early).toBe(5);
    expect(sequenceFromUpdatedAt("2025-01-01T00:00:00Z")).toBe(0);
    expect(sequenceFromUpdatedAt(null)).toBe(0);
    expect(sequenceFromUpdatedAt("2060-01-01T00:00:00Z")).toBeLessThan(2 ** 31);
  });
});
