import { describe, expect, it } from "vitest";
import {
  ARIA_CONDITION_RECONCILIATION_SOURCE,
  ariaLowPackageConditionHolds,
  isAriaActionSnoozedUntilFuture,
  isNewAriaIncidentOccurrence,
  reconcileAriaActionsForStudio,
} from "@/lib/aria/actionReconciliation";
import { FakeSupabase } from "./fakeSupabase";

/**
 * Cleanup PR C: stored ARIA actions are completed only when the authoritative DanceFlow record shows the condition that
 * created them no longer holds. Ambiguous state, other rules, other studios and terminal rows are never touched.
 */

const A = "studio-a";
const B = "studio-b";
const NOW = new Date("2026-10-08T15:00:00.000Z");

function action(fields: Record<string, unknown>) {
  return {
    status: "suggested",
    client_id: null,
    created_at: "2026-10-01T00:00:00.000Z",
    review_note: null,
    completed_at: null,
    ...fields,
  };
}

function run(db: FakeSupabase, studioId = A) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return reconcileAriaActionsForStudio({ supabase: db as any, studioId, now: NOW });
}

function statusOf(db: FakeSupabase, id: string) {
  return db.rows("automation_actions").find((row) => row.id === id)?.status;
}

function eventsFor(db: FakeSupabase, id: string) {
  return db.rows("automation_action_events").filter((row) => row.automation_action_id === id);
}

function lowPackageDb(options: { replacementRemaining?: number | null; lowRemaining?: number } = {}) {
  const packages: Record<string, unknown>[] = [
    { id: "pkg-old", studio_id: A, client_id: "client-1", active: true, expiration_date: null },
  ];
  const items: Record<string, unknown>[] = [
    {
      client_package_id: "pkg-old",
      studio_id: A,
      usage_type: "private_lesson",
      quantity_remaining: options.lowRemaining ?? 1,
      is_unlimited: false,
    },
  ];
  if (options.replacementRemaining !== undefined && options.replacementRemaining !== null) {
    packages.push({ id: "pkg-new", studio_id: A, client_id: "client-1", active: true, expiration_date: null });
    items.push({
      client_package_id: "pkg-new",
      studio_id: A,
      usage_type: "private_lesson",
      quantity_remaining: options.replacementRemaining,
      is_unlimited: false,
    });
  }
  return new FakeSupabase({
    automation_actions: [
      action({
        id: "act-low",
        studio_id: A,
        rule_key: "aria_low_package_balance",
        related_table: "client_packages",
        related_id: "pkg-old",
        client_id: "client-1",
        status: "approved",
      }),
    ],
    automation_action_events: [],
    client_packages: packages,
    client_package_items: items,
  });
}

describe("A/B. aria_low_package_balance", () => {
  it("A: completes once a valid replacement package covers the low balance, with audit evidence", async () => {
    const db = lowPackageDb({ replacementRemaining: 10 });
    const result = await run(db);
    expect(result.completedActionIds).toEqual(["act-low"]);
    const row = db.rows("automation_actions")[0];
    expect(row.status).toBe("completed");
    expect(row.completed_by).toBeNull();
    expect(row.review_note).toContain("Completed automatically");
    const [event] = eventsFor(db, "act-low");
    expect(event).toMatchObject({
      event_type: "completed",
      previous_status: "approved",
      new_status: "completed",
      created_by: null,
    });
    expect(event.metadata).toMatchObject({
      source: ARIA_CONDITION_RECONCILIATION_SOURCE,
      reason: "package_replacement_coverage",
      rule_key: "aria_low_package_balance",
    });
  });

  it("B: stays open while the balance is still low and uncovered", async () => {
    const db = lowPackageDb();
    expect((await run(db)).completed).toBe(0);
    expect(statusOf(db, "act-low")).toBe("approved");
    expect(eventsFor(db, "act-low")).toHaveLength(0);
  });

  it("B: a depleted replacement package is not coverage (keys on the real condition, not 'any package exists')", async () => {
    const db = lowPackageDb({ replacementRemaining: 0 });
    expect((await run(db)).completed).toBe(0);
    expect(statusOf(db, "act-low")).toBe("approved");
  });

  it("completes when the package itself is no longer low (balance restored) or no longer active", async () => {
    const restored = lowPackageDb({ lowRemaining: 8 });
    await run(restored);
    expect(statusOf(restored, "act-low")).toBe("completed");
    expect(eventsFor(restored, "act-low")[0].metadata).toMatchObject({ reason: "package_balance_restored" });

    const inactive = lowPackageDb();
    inactive.rows("client_packages")[0].active = false;
    await run(inactive);
    expect(statusOf(inactive, "act-low")).toBe("completed");
    expect(eventsFor(inactive, "act-low")[0].metadata).toMatchObject({ reason: "package_no_longer_active" });
  });

  it("an expiring-soon package with no low items stays open even if another package exists", () => {
    expect(
      ariaLowPackageConditionHolds({
        targetPackage: {
          id: "p",
          client_id: "c",
          expiration_date: "2026-10-15",
          client_package_items: [{ usage_type: "private_lesson", quantity_remaining: 9, is_unlimited: false }],
        },
        clientActivePackages: [],
        now: NOW,
      }),
    ).toBe(true);
  });

  it("a missing / not visible package is ambiguous and never closes the action", async () => {
    const db = lowPackageDb();
    db.tables.client_packages = [];
    expect((await run(db)).completed).toBe(0);
    expect(statusOf(db, "act-low")).toBe("approved");
  });
});

describe("C. aria_intro_no_purchase", () => {
  function introDb() {
    return new FakeSupabase({
      automation_actions: [
        action({ id: "act-intro", studio_id: A, rule_key: "aria_intro_no_purchase", related_table: "clients", related_id: "client-2" }),
      ],
      automation_action_events: [],
      client_packages: [],
      client_memberships: [],
    });
  }

  it("stays open without a qualifying package or membership", async () => {
    const db = introDb();
    db.rows("client_packages").push({ id: "other", studio_id: A, client_id: "client-other", active: true });
    db.rows("client_packages").push({ id: "inactive", studio_id: A, client_id: "client-2", active: false });
    db.rows("client_memberships").push({ id: "m-old", studio_id: A, client_id: "client-2", status: "cancelled" });
    await run(db);
    expect(statusOf(db, "act-intro")).toBe("suggested");
  });

  it("completes when the same client now has an active package", async () => {
    const db = introDb();
    db.rows("client_packages").push({ id: "pkg", studio_id: A, client_id: "client-2", active: true });
    await run(db);
    expect(statusOf(db, "act-intro")).toBe("completed");
  });

  it("completes when the same client now has a membership", async () => {
    const db = introDb();
    db.rows("client_memberships").push({ id: "m", studio_id: A, client_id: "client-2", status: "active" });
    await run(db);
    expect(statusOf(db, "act-intro")).toBe("completed");
    expect(eventsFor(db, "act-intro")[0].metadata).toMatchObject({ reason: "intro_client_has_membership" });
  });
});

describe("D. aria_payment_exception", () => {
  function paymentDb(status: string | null) {
    return new FakeSupabase({
      automation_actions: [
        action({ id: "act-pay", studio_id: A, rule_key: "aria_payment_exception", related_table: "payments", related_id: "pay-1" }),
      ],
      automation_action_events: [],
      payments: [{ id: "pay-1", studio_id: A, status }],
    });
  }

  it.each(["paid", "completed"])("completes when the payment is now %s", async (status) => {
    const db = paymentDb(status);
    await run(db);
    expect(statusOf(db, "act-pay")).toBe("completed");
  });

  it.each(["refunded", "voided"])("completes when the payment is now %s (nothing left to collect)", async (status) => {
    const db = paymentDb(status);
    await run(db);
    expect(statusOf(db, "act-pay")).toBe("completed");
    expect(eventsFor(db, "act-pay")[0].metadata).toMatchObject({ reason: "payment_closed" });
  });

  it.each(["pending", "failed", "mystery", null])("stays open when the payment is %s", async (status) => {
    const db = paymentDb(status);
    await run(db);
    expect(statusOf(db, "act-pay")).toBe("suggested");
  });
});

describe("E. aria_membership_past_due", () => {
  function membershipDb(status: string) {
    return new FakeSupabase({
      automation_actions: [
        action({
          id: "act-mem",
          studio_id: A,
          rule_key: "aria_membership_past_due",
          related_table: "client_memberships",
          related_id: "mem-1",
        }),
      ],
      automation_action_events: [],
      client_memberships: [{ id: "mem-1", studio_id: A, status }],
    });
  }

  it("completes when the membership is back to active", async () => {
    const db = membershipDb("active");
    await run(db);
    expect(statusOf(db, "act-mem")).toBe("completed");
    expect(eventsFor(db, "act-mem")[0].metadata).toMatchObject({ reason: "membership_billing_current" });
  });

  it("completes when the membership has ended (cancelled)", async () => {
    const db = membershipDb("cancelled");
    await run(db);
    expect(statusOf(db, "act-mem")).toBe("completed");
  });

  it.each(["past_due", "unpaid", "something_new"])("stays open while %s", async (status) => {
    const db = membershipDb(status);
    await run(db);
    expect(statusOf(db, "act-mem")).toBe("suggested");
  });
});

describe("F. aria_booking_request_aging", () => {
  it.each(["approved", "declined", "cancelled"])("completes when the request is %s", async (status) => {
    const db = new FakeSupabase({
      automation_actions: [
        action({ id: "act-br", studio_id: A, rule_key: "aria_booking_request_aging", related_table: "booking_requests", related_id: "br-1" }),
      ],
      automation_action_events: [],
      booking_requests: [{ id: "br-1", studio_id: A, status }],
    });
    await run(db);
    expect(statusOf(db, "act-br")).toBe("completed");
  });

  it("stays open while still pending", async () => {
    const db = new FakeSupabase({
      automation_actions: [
        action({ id: "act-br", studio_id: A, rule_key: "aria_booking_request_aging", related_table: "booking_requests", related_id: "br-1" }),
      ],
      automation_action_events: [],
      booking_requests: [{ id: "br-1", studio_id: A, status: "pending" }],
    });
    await run(db);
    expect(statusOf(db, "act-br")).toBe("suggested");
  });
});

describe("G. aria_external_payment_missing", () => {
  function appointmentDb(fields: Record<string, unknown>) {
    return new FakeSupabase({
      automation_actions: [
        action({
          id: "act-ext",
          studio_id: A,
          rule_key: "aria_external_payment_missing",
          related_table: "appointments",
          related_id: "appt-1",
        }),
      ],
      automation_action_events: [],
      appointments: [{ id: "appt-1", studio_id: A, status: "attended", payment_status: "unpaid", price_amount: 80, ...fields }],
      // an unrelated paid payment for the same client must not count
      payments: [{ id: "unrelated", studio_id: A, status: "paid" }],
    });
  }

  it.each(["paid", "waived", "refunded"])("completes once the appointment's own payment is recorded (%s)", async (payment_status) => {
    const db = appointmentDb({ payment_status });
    await run(db);
    expect(statusOf(db, "act-ext")).toBe("completed");
  });

  it("completes when the appointment was cancelled", async () => {
    const db = appointmentDb({ status: "cancelled" });
    await run(db);
    expect(statusOf(db, "act-ext")).toBe("completed");
  });

  it.each(["unpaid", "partial"])("stays open while %s, regardless of unrelated payments", async (payment_status) => {
    const db = appointmentDb({ payment_status });
    await run(db);
    expect(statusOf(db, "act-ext")).toBe("suggested");
  });
});

describe("H/I/Q. scope: other rules, other studios, terminal rows", () => {
  function mixedDb() {
    return new FakeSupabase({
      automation_actions: [
        action({ id: "a-pay", studio_id: A, rule_key: "aria_payment_exception", related_table: "payments", related_id: "pay-a" }),
        // H: a judgement rule pointing at the same kind of record is never auto-resolved
        action({ id: "a-noshow", studio_id: A, rule_key: "aria_no_show_service_recovery", related_table: "payments", related_id: "pay-a" }),
        // I: another studio's action on its own (resolved) payment
        action({ id: "b-pay", studio_id: B, rule_key: "aria_payment_exception", related_table: "payments", related_id: "pay-b" }),
        // I: another studio's action pointing at studio A's payment id must not be resolved by A's run either
        action({ id: "b-cross", studio_id: B, rule_key: "aria_payment_exception", related_table: "payments", related_id: "pay-a" }),
        // Q: terminal history stays exactly as staff left it
        action({
          id: "a-dismissed",
          studio_id: A,
          rule_key: "aria_payment_exception",
          related_table: "payments",
          related_id: "pay-a",
          status: "dismissed",
          review_note: "Handled by phone.",
        }),
        // queued: delivery in flight, owned by the delivery lifecycle
        action({ id: "a-queued", studio_id: A, rule_key: "aria_payment_exception", related_table: "payments", related_id: "pay-a", status: "queued" }),
      ],
      automation_action_events: [],
      payments: [
        { id: "pay-a", studio_id: A, status: "paid" },
        { id: "pay-b", studio_id: B, status: "paid" },
      ],
    });
  }

  it("only studio A's eligible supported action is completed", async () => {
    const db = mixedDb();
    const result = await run(db, A);
    expect(result.completedActionIds).toEqual(["a-pay"]);
    expect(statusOf(db, "a-noshow")).toBe("suggested");
    expect(statusOf(db, "b-pay")).toBe("suggested");
    expect(statusOf(db, "b-cross")).toBe("suggested");
    expect(statusOf(db, "a-dismissed")).toBe("dismissed");
    expect(db.rows("automation_actions").find((row) => row.id === "a-dismissed")?.review_note).toBe("Handled by phone.");
    expect(statusOf(db, "a-queued")).toBe("queued");
    expect(db.rows("automation_action_events").map((event) => event.automation_action_id)).toEqual(["a-pay"]);
  });

  it("every query and write of studio A's run is scoped to studio A", async () => {
    const db = mixedDb();
    await run(db, A);
    const studioScoped = db.operations.filter((operation) => operation.op !== "insert");
    expect(studioScoped.length).toBeGreaterThan(0);
    for (const operation of studioScoped) {
      expect(operation.eqs).toContainEqual(["studio_id", A]);
    }
    for (const event of db.rows("automation_action_events")) {
      expect(event.studio_id).toBe(A);
    }
  });

  it("studio B's own run resolves B's action from B's own payment only", async () => {
    const db = mixedDb();
    db.rows("payments").find((row) => row.id === "pay-a")!.status = "failed";
    await run(db, B);
    expect(statusOf(db, "b-pay")).toBe("completed");
    // B's action that names A's payment id cannot see A's row: ambiguous, stays open
    expect(statusOf(db, "b-cross")).toBe("suggested");
    expect(statusOf(db, "a-pay")).toBe("suggested");
  });
});

describe("O/P. idempotency and concurrency", () => {
  it("O: replaying reconciliation changes nothing and records no further events", async () => {
    const db = lowPackageDb({ replacementRemaining: 10 });
    await run(db);
    const after = { ...db.rows("automation_actions")[0] };
    const second = await run(db);
    expect(second).toMatchObject({ checked: 0, completed: 0, completedActionIds: [], expiredActionIds: [], refreshedActionIds: [] });
    expect(db.rows("automation_actions")[0]).toEqual(after);
    expect(eventsFor(db, "act-low")).toHaveLength(1);
    expect(db.rows("automation_actions")).toHaveLength(1);
  });

  it("P: two overlapping runs converge to one completion and one completed event", async () => {
    const db = lowPackageDb({ replacementRemaining: 10 });
    const [first, second] = await Promise.all([run(db), run(db)]);
    expect(first.completed + second.completed).toBe(1);
    expect(statusOf(db, "act-low")).toBe("completed");
    expect(eventsFor(db, "act-low")).toHaveLength(1);
  });

  it("P: a status change by staff between read and write wins (guarded update)", async () => {
    const db = lowPackageDb({ replacementRemaining: 10 });
    const original = db.from.bind(db);
    let dismissedByStaff = false;
    db.from = (table: string) => {
      const query = original(table);
      if (table === "automation_actions" && !dismissedByStaff) {
        const update = query.update.bind(query);
        query.update = (payload: unknown) => {
          dismissedByStaff = true;
          db.rows("automation_actions")[0].status = "dismissed";
          return update(payload);
        };
      }
      return query;
    };
    const result = await run(db);
    expect(result.completed).toBe(0);
    expect(statusOf(db, "act-low")).toBe("dismissed");
    expect(eventsFor(db, "act-low")).toHaveLength(0);
  });
});

describe("snooze helper", () => {
  it("only a future snoozed_until on a snoozed action hides it", () => {
    expect(isAriaActionSnoozedUntilFuture({ status: "snoozed", snoozed_until: "2026-10-09T00:00:00.000Z" }, NOW)).toBe(true);
    expect(isAriaActionSnoozedUntilFuture({ status: "snoozed", snoozed_until: "2026-10-08T14:59:59.000Z" }, NOW)).toBe(false);
    expect(isAriaActionSnoozedUntilFuture({ status: "snoozed", snoozed_until: null }, NOW)).toBe(false);
    expect(isAriaActionSnoozedUntilFuture({ status: "approved", snoozed_until: "2026-10-09T00:00:00.000Z" }, NOW)).toBe(false);
  });
});

describe("legacy low_package_balance (Evaluate now) uses the studio's configured threshold", () => {
  function legacyDb(threshold: number | null, remaining: number, replacement?: number) {
    const packages: Record<string, unknown>[] = [{ id: "pkg-1", studio_id: A, client_id: "client-1", active: true, expiration_date: null }];
    const items: Record<string, unknown>[] = [
      { client_package_id: "pkg-1", studio_id: A, usage_type: "private_lesson", quantity_remaining: remaining, is_unlimited: false },
    ];
    if (replacement !== undefined) {
      packages.push({ id: "pkg-2", studio_id: A, client_id: "client-1", active: true, expiration_date: null });
      items.push({ client_package_id: "pkg-2", studio_id: A, usage_type: "private_lesson", quantity_remaining: replacement, is_unlimited: false });
    }
    return new FakeSupabase({
      automation_rules: threshold === null ? [] : [{ studio_id: A, rule_key: "low_package_balance", trigger_config: { threshold } }],
      automation_actions: [
        action({ id: "legacy", studio_id: A, rule_key: "low_package_balance", related_table: "client_packages", related_id: "pkg-1" }),
      ],
      automation_action_events: [],
      client_packages: packages,
      client_package_items: items,
    });
  }

  it("stays open at 4 remaining when the studio threshold is 5 (ARIA's fixed 2 would wrongly close it)", async () => {
    const db = legacyDb(5, 4);
    await run(db);
    expect(statusOf(db, "legacy")).toBe("suggested");
  });

  it("completes once the balance is above the configured threshold", async () => {
    const db = legacyDb(5, 6);
    await run(db);
    expect(statusOf(db, "legacy")).toBe("completed");
  });

  it("completes when a replacement package covers the low balance (default threshold when unset)", async () => {
    const db = legacyDb(null, 1, 10);
    await run(db);
    expect(statusOf(db, "legacy")).toBe("completed");
    expect(eventsFor(db, "legacy")[0].metadata).toMatchObject({ reason: "package_replacement_coverage", rule_key: "low_package_balance" });
  });
});

describe("isNewAriaIncidentOccurrence", () => {
  const closed = (fields: Partial<{ status: string; created_at: string; systemObservedResolution: boolean }>) => ({
    id: "x",
    status: "dismissed",
    created_at: "2026-10-01T00:00:00.000Z",
    systemObservedResolution: false,
    ...fields,
  });

  it("staff-closed + no new-occurrence evidence = same incident", () => {
    expect(isNewAriaIncidentOccurrence({ ruleKey: "aria_payment_exception", latest: closed({}), now: NOW })).toBe(false);
    expect(isNewAriaIncidentOccurrence({ ruleKey: "aria_payment_exception", latest: closed({ status: "completed" }), now: NOW })).toBe(false);
  });

  it("system-observed resolution, a later occurrence start, or the rule's existing re-notify window = new occurrence", () => {
    expect(
      isNewAriaIncidentOccurrence({ ruleKey: "aria_payment_exception", latest: closed({ status: "completed", systemObservedResolution: true }), now: NOW }),
    ).toBe(true);
    expect(
      isNewAriaIncidentOccurrence({
        ruleKey: "aria_membership_past_due",
        latest: closed({}),
        incidentStartedAt: "2026-10-05T00:00:00.000Z",
        now: NOW,
      }),
    ).toBe(true);
    expect(
      isNewAriaIncidentOccurrence({
        ruleKey: "aria_membership_past_due",
        latest: closed({}),
        incidentStartedAt: "2026-09-01T00:00:00.000Z",
        now: NOW,
      }),
    ).toBe(false);
    expect(
      isNewAriaIncidentOccurrence({ ruleKey: "aria_low_package_balance", latest: closed({ created_at: "2026-09-01T00:00:00.000Z" }), now: NOW }),
    ).toBe(true);
    expect(isNewAriaIncidentOccurrence({ ruleKey: "aria_low_package_balance", latest: closed({}), now: NOW })).toBe(false);
  });

  it("in-flight rows (awaiting_outcome, failed) always suppress", () => {
    for (const status of ["awaiting_outcome", "failed"]) {
      expect(
        isNewAriaIncidentOccurrence({
          ruleKey: "aria_low_package_balance",
          latest: closed({ status, created_at: "2026-01-01T00:00:00.000Z", systemObservedResolution: true }),
          now: NOW,
        }),
      ).toBe(false);
    }
  });
});
