import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  classifyAriaDigestFailure,
  recordTerminalAriaDigestFailure,
  redactSensitiveText,
  sanitizeAriaDigestError,
} from "@/lib/aria/digest-observability";

/**
 * Simulates the real platform_error_logs table's partial unique index
 * (source = 'aria_digest', details->>'dedupe_key') so tests exercise the
 * same constraint-enforced dedup behavior the production migration
 * provides, rather than an application-level check.
 */
function createFakePlatformErrorLogsClient(
  options: {
    existingDedupeKeys?: string[];
    onInsert?: (row: Record<string, unknown>) => void;
    insertError?: { message: string; code?: string } | null;
  } = {},
) {
  const dedupeKeys = new Set(options.existingDedupeKeys ?? []);

  return {
    from(table: string) {
      if (table !== "platform_error_logs") {
        throw new Error(`Unexpected table in fake client: ${table}`);
      }

      return {
        insert: async (row: Record<string, unknown>) => {
          if (options.insertError) {
            return { error: options.insertError };
          }

          const details = row.details as Record<string, unknown>;
          const dedupeKey = details?.dedupe_key as string;

          if (dedupeKeys.has(dedupeKey)) {
            return {
              error: {
                message:
                  'duplicate key value violates unique constraint "platform_error_logs_aria_digest_dedupe_idx"',
                code: "23505",
              },
            };
          }

          dedupeKeys.add(dedupeKey);
          options.onInsert?.(row);
          return { error: null };
        },
      };
    },
  };
}

describe("classifyAriaDigestFailure", () => {
  it("treats a run without a delivery_id as terminal regardless of retry count", () => {
    expect(
      classifyAriaDigestFailure({ retryCount: 0, hasDeliveryId: false }),
    ).toBe("terminal");
  });

  it("treats a run with a delivery_id under the retry ceiling as retryable", () => {
    expect(
      classifyAriaDigestFailure({ retryCount: 0, hasDeliveryId: true }),
    ).toBe("retry");
    expect(
      classifyAriaDigestFailure({ retryCount: 2, hasDeliveryId: true }),
    ).toBe("retry");
  });

  it("treats a run with a delivery_id at or above the retry ceiling as terminal", () => {
    expect(
      classifyAriaDigestFailure({ retryCount: 3, hasDeliveryId: true }),
    ).toBe("terminal");
    expect(
      classifyAriaDigestFailure({ retryCount: 4, hasDeliveryId: true }),
    ).toBe("terminal");
  });
});

describe("redactSensitiveText", () => {
  it("redacts email addresses", () => {
    const result = redactSensitiveText("Delivery failed for owner@studio.com");
    expect(result).not.toContain("owner@studio.com");
    expect(result).toContain("[redacted-email]");
  });

  it("redacts bearer/basic authorization headers", () => {
    const result = redactSensitiveText("Request failed: Authorization: Bearer sk_live_abcdef123456");
    expect(result).not.toMatch(/Bearer sk_live_abcdef123456/i);
    expect(result).toContain("[redacted-authorization]");
  });

  it("redacts provider API keys", () => {
    const result = redactSensitiveText("Resend rejected key re_1234567890abcdef");
    expect(result).not.toContain("re_1234567890abcdef");
    expect(result).toContain("[redacted-api-key]");
  });

  it("redacts long hex tokens", () => {
    const result = redactSensitiveText(`Token ${"a1b2c3d4".repeat(4)} was invalid`);
    expect(result).toContain("[redacted-token]");
  });

  it("redacts JWT-shaped values", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyLTEyMyIsInJvbGUiOiJhZG1pbiJ9.4Adcj3UFYzPUVaVF43FmMab6RlaQD8A9V8wFzzht-KQ";
    const result = redactSensitiveText(`Auth failed for token ${jwt}`);
    expect(result).not.toContain(jwt);
    expect(result).toContain("[redacted-jwt]");
  });

  it("redacts generic high-entropy base64/base64url-looking secrets", () => {
    const secret = "AbCdEf123456ZyXwVu987654QsT";
    const result = redactSensitiveText(`Config rejected value ${secret}`);
    expect(result).not.toContain(secret);
    expect(result).toContain("[redacted-secret]");
  });

  it("leaves ordinary text untouched", () => {
    const result = redactSensitiveText("Connection timed out after 30s");
    expect(result).toBe("Connection timed out after 30s");
  });

  it("does not aggressively redact ordinary short strings or plain words", () => {
    const result = redactSensitiveText("Studio settings updated successfully after retry 2");
    expect(result).toBe("Studio settings updated successfully after retry 2");
  });
});

describe("sanitizeAriaDigestError", () => {
  it("redacts and truncates long error messages", () => {
    const longMessage = `owner@studio.com ${"x".repeat(600)}`;
    const sanitized = sanitizeAriaDigestError(new Error(longMessage));

    expect(sanitized.name).toBe("Error");
    expect(sanitized.message).not.toContain("owner@studio.com");
    expect(sanitized.message.length).toBeLessThanOrEqual(501);
  });

  it("handles non-Error values", () => {
    const sanitized = sanitizeAriaDigestError("plain string failure");
    expect(sanitized.message).toBe("plain string failure");
  });
});

describe("recordTerminalAriaDigestFailure", () => {
  const baseParams = {
    runId: "run-1",
    studioId: "studio-1",
    digestType: "morning" as const,
    digestDate: "2026-08-08",
    deliveryId: "delivery-1",
    retryCount: 3,
  };

  it("inserts a redacted alert when no alert exists yet for the run", async () => {
    const inserted: Record<string, unknown>[] = [];
    const client = createFakePlatformErrorLogsClient({
      onInsert: (row) => inserted.push(row),
    });

    const result = await recordTerminalAriaDigestFailure(
      client as unknown as SupabaseClient,
      { ...baseParams, error: new Error("Resend rejected owner@studio.com") },
    );

    expect(result).toEqual({ alerted: true, deduped: false });
    expect(inserted).toHaveLength(1);

    const [row] = inserted;
    expect(row.severity).toBe("critical");
    expect(row.source).toBe("aria_digest");
    expect(JSON.stringify(row)).not.toContain("owner@studio.com");

    const details = row.details as Record<string, unknown>;
    expect(details.dedupe_key).toBe("aria_digest_terminal:run-1");
    expect(details.run_id).toBe("run-1");
  });

  it("treats a database unique-violation (23505) as a successful dedup, not an error", async () => {
    // Models two concurrent workers racing to insert the same run's terminal
    // alert against the real partial unique index: the database serializes
    // them, the loser gets 23505, and that must be reported as dedup, not
    // a failure.
    const inserted: Record<string, unknown>[] = [];
    const client = createFakePlatformErrorLogsClient({
      onInsert: (row) => inserted.push(row),
    });

    const first = await recordTerminalAriaDigestFailure(
      client as unknown as SupabaseClient,
      { ...baseParams, error: new Error("Resend rejected") },
    );
    const second = await recordTerminalAriaDigestFailure(
      client as unknown as SupabaseClient,
      { ...baseParams, error: new Error("Resend rejected again, moments later") },
    );

    expect(first).toEqual({ alerted: true, deduped: false });
    expect(second).toEqual({ alerted: false, deduped: true });
    expect(inserted).toHaveLength(1);
  });

  it("still dedupes a repeated cron pass even after the original alert was resolved", async () => {
    // The unique index is not conditioned on resolved_at, so an occupied
    // dedupe_key blocks a new insert regardless of whether that row has
    // since been marked resolved.
    const client = createFakePlatformErrorLogsClient({
      existingDedupeKeys: ["aria_digest_terminal:run-1"],
    });

    const result = await recordTerminalAriaDigestFailure(
      client as unknown as SupabaseClient,
      { ...baseParams, error: new Error("Resend rejected") },
    );

    expect(result).toEqual({ alerted: false, deduped: true });
  });

  it("does not suppress a genuinely distinct failure for a different run", async () => {
    const inserted: Record<string, unknown>[] = [];
    const client = createFakePlatformErrorLogsClient({
      existingDedupeKeys: ["aria_digest_terminal:run-1"],
      onInsert: (row) => inserted.push(row),
    });

    const result = await recordTerminalAriaDigestFailure(
      client as unknown as SupabaseClient,
      { ...baseParams, runId: "run-2", error: new Error("Resend rejected") },
    );

    expect(result).toEqual({ alerted: true, deduped: false });
    expect(inserted).toHaveLength(1);
  });

  it("does not throw and reports failure when the insert fails for a non-dedup reason", async () => {
    const client = createFakePlatformErrorLogsClient({
      insertError: { message: "connection reset" },
    });

    const result = await recordTerminalAriaDigestFailure(
      client as unknown as SupabaseClient,
      { ...baseParams, error: new Error("Resend rejected") },
    );

    expect(result).toEqual({ alerted: false, deduped: false });
  });
});
