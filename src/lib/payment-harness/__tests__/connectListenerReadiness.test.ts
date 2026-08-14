import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { FakeTable, createFakeAdminClient } from "@/lib/payments/__tests__/fakeSupabase";
import {
  assertConnectListenerReady,
  type ConnectTriggerFn,
  type StripeEventClientFactory,
} from "@/lib/payment-harness/connectListenerReadiness";
import { PaymentHarnessSafetyError } from "@/lib/payment-harness/guards";

/**
 * Regression coverage for the deterministic Stripe Connect listener
 * readiness gate. No real Stripe CLI invocation and no real Stripe API
 * call happens anywhere in this file -- every test injects a fake
 * `triggerFn` and a fake `createStripeEventClient`, and DB access goes
 * through the same FakeTable/createFakeAdminClient fixture already shared
 * across the payments test suite.
 */

const CONNECTED_ACCOUNT_ID = "acct_test_fake_not_real";
const EVENT_ID = "evt_test_fake_readiness_probe";
const TRIGGER_STARTED_AT = new Date("2026-01-01T00:00:00.000Z");
const AFTER_TRIGGER = "2026-01-01T00:00:05.000Z";
const BEFORE_TRIGGER = "2025-12-31T23:59:00.000Z";

const ENV_KEYS = ["PAYMENT_HARNESS_STRIPE_SECRET_KEY", "STRIPE_SECRET_KEY"] as const;
let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

let eventsTable: FakeTable;

function fakeAdmin() {
  return createFakeAdminClient({ payment_provider_events: eventsTable }) as never;
}

function seedRow(overrides: Record<string, unknown> = {}) {
  const row = {
    id: `row-${eventsTable.rows.length + 1}`,
    provider: "stripe",
    event_type: "product.updated",
    status: "processed",
    provider_event_id: EVENT_ID,
    created_at: AFTER_TRIGGER,
    ...overrides,
  };
  eventsTable.rows.push(row);
  return row;
}

function successfulTrigger(): ConnectTriggerFn {
  return async () => ({
    exitCode: 0,
    stdout: "Trigger succeeded! Check dashboard for event details.",
    stderr: "",
  });
}

function failingTrigger(exitCode = 1): ConnectTriggerFn {
  return async () => ({ exitCode, stdout: "", stderr: "some CLI error" });
}

function throwingTrigger(): ConnectTriggerFn {
  return async () => {
    throw new Error("simulated timeout/kill");
  };
}

function validEventClient(
  overrides: Partial<{ id: string; type: string; livemode: boolean; account: string }> = {},
): StripeEventClientFactory {
  return () => ({
    events: {
      retrieve: async () => ({
        id: EVENT_ID,
        type: "product.updated",
        livemode: false,
        account: CONNECTED_ACCOUNT_ID,
        ...overrides,
      }),
    },
  });
}

function throwingEventClient(): StripeEventClientFactory {
  return () => ({
    events: {
      retrieve: async () => {
        throw new Error("simulated Stripe retrieval failure");
      },
    },
  });
}

const noopSleep = async () => {};
const fixedNow = () => TRIGGER_STARTED_AT;

function baseParams(overrides: Partial<Parameters<typeof assertConnectListenerReady>[0]> = {}) {
  return {
    adminSupabase: fakeAdmin(),
    connectedAccountId: CONNECTED_ACCOUNT_ID,
    environment: "development" as const,
    context: "t",
    triggerFn: successfulTrigger(),
    now: fixedNow,
    sleepFn: noopSleep,
    pollMaxAttempts: 3,
    pollIntervalMs: 0,
    createStripeEventClient: validEventClient(),
    ...overrides,
  };
}

beforeEach(() => {
  eventsTable = new FakeTable();
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.PAYMENT_HARNESS_STRIPE_SECRET_KEY = "sk_test_fake_harness_key_not_real";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("assertConnectListenerReady", () => {
  it("passes when a fresh, valid readiness proof is found, and returns matching evidence", async () => {
    seedRow();
    const result = await assertConnectListenerReady(baseParams());
    expect(result).toEqual({
      providerEventId: EVENT_ID,
      eventType: "product.updated",
      dbStatus: "processed",
      stripeEventAccount: CONNECTED_ACCOUNT_ID,
      livemode: false,
      verifiedAt: expect.any(String),
    });
  });

  it("does not require the CLI to expose an event id -- generic success text is enough to proceed to DB correlation", async () => {
    seedRow();
    await expect(
      assertConnectListenerReady(
        baseParams({ triggerFn: async () => ({ exitCode: 0, stdout: "Trigger succeeded!", stderr: "" }) }),
      ),
    ).resolves.toMatchObject({ providerEventId: EVENT_ID });
  });

  it("fails closed when the CLI trigger exits non-zero", async () => {
    seedRow();
    await expect(
      assertConnectListenerReady(baseParams({ triggerFn: failingTrigger(1) })),
    ).rejects.toThrow(PaymentHarnessSafetyError);
  });

  it("uses the CONNECT_LISTENER_TRIGGER_FAILED code for a non-zero exit", async () => {
    try {
      await assertConnectListenerReady(baseParams({ triggerFn: failingTrigger(1) }));
      throw new Error("expected to throw");
    } catch (error) {
      expect((error as PaymentHarnessSafetyError).code).toBe("CONNECT_LISTENER_TRIGGER_FAILED");
    }
  });

  it("fails closed when the CLI trigger times out / throws before resolving", async () => {
    await expect(
      assertConnectListenerReady(baseParams({ triggerFn: throwingTrigger() })),
    ).rejects.toThrow(PaymentHarnessSafetyError);
  });

  it("uses the CONNECT_LISTENER_TRIGGER_FAILED code for a timeout/throw", async () => {
    try {
      await assertConnectListenerReady(baseParams({ triggerFn: throwingTrigger() }));
      throw new Error("expected to throw");
    } catch (error) {
      expect((error as PaymentHarnessSafetyError).code).toBe("CONNECT_LISTENER_TRIGGER_FAILED");
    }
  });

  it("continues polling (does not bail early) on zero matching rows, then times out", async () => {
    // eventsTable deliberately left empty for the whole run.
    let sleepCalls = 0;
    const countingSleep = async () => {
      sleepCalls += 1;
    };

    try {
      await assertConnectListenerReady(baseParams({ pollMaxAttempts: 3, sleepFn: countingSleep }));
      throw new Error("expected to throw");
    } catch (error) {
      expect((error as PaymentHarnessSafetyError).code).toBe("CONNECT_LISTENER_READINESS_TIMEOUT");
    }
    // 3 attempts -> 2 sleeps between them (never sleeps after the last
    // attempt) -- proves the loop genuinely polled rather than bailing on
    // the first empty result.
    expect(sleepCalls).toBe(2);
  });

  it("never mistakes a row created before the trigger for a fresh readiness proof", async () => {
    seedRow({ created_at: BEFORE_TRIGGER });
    await expect(assertConnectListenerReady(baseParams())).rejects.toThrow(PaymentHarnessSafetyError);
  });

  it("fails closed (ambiguous) when more than one plausible matching row appears, without picking the newest", async () => {
    seedRow();
    seedRow({ provider_event_id: "evt_test_fake_other" });
    await expect(assertConnectListenerReady(baseParams())).rejects.toThrow(PaymentHarnessSafetyError);
  });

  it("uses the CONNECT_LISTENER_READINESS_AMBIGUOUS code for multiple matches", async () => {
    seedRow();
    seedRow({ provider_event_id: "evt_test_fake_other" });
    try {
      await assertConnectListenerReady(baseParams());
      throw new Error("expected to throw");
    } catch (error) {
      expect((error as PaymentHarnessSafetyError).code).toBe("CONNECT_LISTENER_READINESS_AMBIGUOUS");
    }
  });

  // The real webhook route (src/app/api/payments/webhook/route.ts) inserts
  // the payment_provider_events row at status="received" *before* running
  // the event's business logic, then updates it to "processed"/"failed"
  // afterward via a separate write. A row observed at "received" is
  // therefore a normal, expected transient state -- these tests prove the
  // gate keeps polling through it rather than failing closed immediately.

  it("keeps polling (does not fail closed) on a matched row still at status='received', and succeeds once it transitions to 'processed'", async () => {
    const row = seedRow({ status: "received" });
    let sleepCalls = 0;
    const transitionOnFirstSleep = async () => {
      sleepCalls += 1;
      if (sleepCalls === 1) {
        row.status = "processed";
      }
    };

    await expect(
      assertConnectListenerReady(
        baseParams({ pollMaxAttempts: 5, sleepFn: transitionOnFirstSleep }),
      ),
    ).resolves.toMatchObject({ dbStatus: "processed" });
    expect(sleepCalls).toBeGreaterThanOrEqual(1);
  });

  it("times out (CONNECT_LISTENER_READINESS_TIMEOUT), not NOT_PROCESSED, when a matched row stays at status='received' for the whole polling budget", async () => {
    seedRow({ status: "received" });
    let sleepCalls = 0;
    const countingSleep = async () => {
      sleepCalls += 1;
    };

    try {
      await assertConnectListenerReady(baseParams({ pollMaxAttempts: 3, sleepFn: countingSleep }));
      throw new Error("expected to throw");
    } catch (error) {
      expect((error as PaymentHarnessSafetyError).code).toBe("CONNECT_LISTENER_READINESS_TIMEOUT");
    }
    // Proves the row was polled through its full non-terminal life, not
    // bailed on at the first sighting.
    expect(sleepCalls).toBe(2);
  });

  it("keeps polling on an unrecognized/other non-terminal status just like 'received'", async () => {
    seedRow({ status: "some_future_status_this_code_has_never_seen" });
    try {
      await assertConnectListenerReady(baseParams({ pollMaxAttempts: 2 }));
      throw new Error("expected to throw");
    } catch (error) {
      expect((error as PaymentHarnessSafetyError).code).toBe("CONNECT_LISTENER_READINESS_TIMEOUT");
    }
  });

  it("fails closed immediately (does not keep polling) when the matched row is status='failed'", async () => {
    seedRow({ status: "failed" });
    let sleepCalls = 0;
    const countingSleep = async () => {
      sleepCalls += 1;
    };

    try {
      await assertConnectListenerReady(baseParams({ pollMaxAttempts: 5, sleepFn: countingSleep }));
      throw new Error("expected to throw");
    } catch (error) {
      expect((error as PaymentHarnessSafetyError).code).toBe("CONNECT_LISTENER_READINESS_PROBE_FAILED");
    }
    // No sleep/retry happened -- the loop broke on the very first attempt.
    expect(sleepCalls).toBe(0);
  });

  it("a status='processed' match still proceeds to exact Stripe Event verification (id/type/livemode/account all checked)", async () => {
    seedRow({ status: "processed" });
    try {
      await assertConnectListenerReady(
        baseParams({ createStripeEventClient: validEventClient({ account: "acct_wrong_account" }) }),
      );
      throw new Error("expected to throw");
    } catch (error) {
      // Reaching this specific, later-stage code proves the gate did not
      // stop at the status check -- it went on to retrieve and verify the
      // real Stripe Event.
      expect((error as PaymentHarnessSafetyError).code).toBe(
        "CONNECT_LISTENER_READINESS_EVENT_ACCOUNT_MISMATCH",
      );
    }
  });

  it("fails closed when provider_event_id is missing", async () => {
    seedRow({ provider_event_id: null });
    await expect(assertConnectListenerReady(baseParams())).rejects.toThrow(PaymentHarnessSafetyError);
  });

  it("fails closed when provider_event_id is malformed (does not look like evt_...)", async () => {
    seedRow({ provider_event_id: "not-a-real-event-id" });
    try {
      await assertConnectListenerReady(baseParams());
      throw new Error("expected to throw");
    } catch (error) {
      expect((error as PaymentHarnessSafetyError).code).toBe("CONNECT_LISTENER_READINESS_EVENT_ID_MALFORMED");
    }
  });

  it("fails closed when Stripe event retrieval itself fails", async () => {
    seedRow();
    await expect(
      assertConnectListenerReady(baseParams({ createStripeEventClient: throwingEventClient() })),
    ).rejects.toThrow(PaymentHarnessSafetyError);
  });

  it("uses the CONNECT_LISTENER_READINESS_EVENT_RETRIEVAL_FAILED code for a retrieval failure", async () => {
    seedRow();
    try {
      await assertConnectListenerReady(baseParams({ createStripeEventClient: throwingEventClient() }));
      throw new Error("expected to throw");
    } catch (error) {
      expect((error as PaymentHarnessSafetyError).code).toBe(
        "CONNECT_LISTENER_READINESS_EVENT_RETRIEVAL_FAILED",
      );
    }
  });

  it("fails closed when the retrieved event id does not match the DB row's provider_event_id", async () => {
    seedRow();
    try {
      await assertConnectListenerReady(
        baseParams({ createStripeEventClient: validEventClient({ id: "evt_test_fake_different" }) }),
      );
      throw new Error("expected to throw");
    } catch (error) {
      expect((error as PaymentHarnessSafetyError).code).toBe("CONNECT_LISTENER_READINESS_EVENT_ID_MISMATCH");
    }
  });

  it("fails closed when the retrieved event type does not match product.updated", async () => {
    seedRow();
    try {
      await assertConnectListenerReady(
        baseParams({ createStripeEventClient: validEventClient({ type: "customer.updated" }) }),
      );
      throw new Error("expected to throw");
    } catch (error) {
      expect((error as PaymentHarnessSafetyError).code).toBe(
        "CONNECT_LISTENER_READINESS_EVENT_TYPE_MISMATCH",
      );
    }
  });

  it("fails closed when the retrieved event is livemode", async () => {
    seedRow();
    try {
      await assertConnectListenerReady(
        baseParams({ createStripeEventClient: validEventClient({ livemode: true }) }),
      );
      throw new Error("expected to throw");
    } catch (error) {
      // Reuses the real Slice 2 stripeTestMode.ts codes.
      expect((error as PaymentHarnessSafetyError).code).toBe("STRIPE_LIVEMODE_TRUE");
    }
  });

  it("fails closed when the retrieved event's connected account does not match", async () => {
    seedRow();
    try {
      await assertConnectListenerReady(
        baseParams({ createStripeEventClient: validEventClient({ account: "acct_wrong_account" }) }),
      );
      throw new Error("expected to throw");
    } catch (error) {
      expect((error as PaymentHarnessSafetyError).code).toBe(
        "CONNECT_LISTENER_READINESS_EVENT_ACCOUNT_MISMATCH",
      );
    }
  });

  it("fails closed when the configured environment is not allowed", async () => {
    seedRow();
    await expect(
      assertConnectListenerReady(baseParams({ environment: "production" as never })),
    ).rejects.toThrow(PaymentHarnessSafetyError);
  });

  it("never falls back to the application's own STRIPE_SECRET_KEY", async () => {
    delete process.env.PAYMENT_HARNESS_STRIPE_SECRET_KEY;
    process.env.STRIPE_SECRET_KEY = "sk_test_should_never_be_used_by_the_harness";
    seedRow();
    await expect(assertConnectListenerReady(baseParams())).rejects.toThrow(PaymentHarnessSafetyError);
  });

  it("never queries payment_provider_events with anything but .select()", () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(path.join(dir, "..", "connectListenerReadiness.ts"), "utf8");
    expect(/\.update\(/.test(source)).toBe(false);
    expect(/\.insert\(/.test(source)).toBe(false);
    expect(/\.delete\(/.test(source)).toBe(false);
  });

  it("never leaks the Stripe secret key into a thrown error message, even on a trigger failure", async () => {
    const secretMarker = "sk_test_marked_secret_value_zzz";
    process.env.PAYMENT_HARNESS_STRIPE_SECRET_KEY = secretMarker;

    let message = "";
    try {
      await assertConnectListenerReady(baseParams({ triggerFn: failingTrigger(1) }));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain(secretMarker);
  });

  it("never leaks the Stripe secret key into a thrown error message on a retrieval failure", async () => {
    const secretMarker = "sk_test_marked_secret_value_zzz2";
    process.env.PAYMENT_HARNESS_STRIPE_SECRET_KEY = secretMarker;
    seedRow();

    let message = "";
    try {
      await assertConnectListenerReady(baseParams({ createStripeEventClient: throwingEventClient() }));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain(secretMarker);
  });

  it("the returned readiness evidence never contains the Stripe secret key", async () => {
    const secretMarker = "sk_test_marked_secret_value_evidence_zzz";
    process.env.PAYMENT_HARNESS_STRIPE_SECRET_KEY = secretMarker;
    seedRow();

    const result = await assertConnectListenerReady(baseParams());
    expect(JSON.stringify(result)).not.toContain(secretMarker);
    // The evidence is a small, fixed set of ids/status/booleans/timestamp --
    // never anything shaped like a Stripe secret key.
    expect(Object.keys(result).sort()).toEqual(
      ["dbStatus", "eventType", "livemode", "providerEventId", "stripeEventAccount", "verifiedAt"].sort(),
    );
  });
});
