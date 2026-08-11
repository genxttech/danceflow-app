import { describe, expect, it, vi, beforeEach } from "vitest";
import { FakeTable, createFakeAdminClient } from "@/lib/payments/__tests__/fakeSupabase";
import { SuiteAssertionError } from "@/lib/synthetic/suites/contract";
import type { SuiteContext } from "@/lib/synthetic/suites/contract";
import type { SyntheticConfig } from "@/lib/synthetic/types";

/**
 * SYN-PAY-READ-001 regression coverage, specifically for the
 * unauthorized-write probe's failure-mode safety: if the write it expects
 * RLS to reject unexpectedly succeeds, the created row must still end up
 * in created_record_refs (auditable) and still get cleaned up -- a
 * security regression probe must never itself leave untracked, unremoved
 * state behind on the exact path it exists to detect.
 */

let adminTable: FakeTable;

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => createFakeAdminClient({ payments: adminTable }),
}));

const { runPaymentsReadSuite, cleanupPaymentsReadSuite } = await import("@/lib/synthetic/suites/paymentsRead");

const CONFIG: SyntheticConfig = {
  studioId: "studio-syn",
  supabaseUrl: "https://example.supabase.co",
  supabaseAnonKey: "anon-key",
  identities: {},
  eventFixture: null,
};

function makeCtx(sessionClient: unknown): SuiteContext {
  return {
    runId: "syn_test",
    config: CONFIG,
    sessions: {
      student: {
        role: "student",
        client: sessionClient as never,
        userId: "user-student",
        studioId: CONFIG.studioId,
      },
    },
  };
}

function makeSessionClient(options: {
  visiblePayments?: { studio_id: string }[];
  rpcRejects?: boolean;
  insertSucceeds?: boolean;
  insertedId?: string;
}) {
  return {
    from(table: string) {
      if (table !== "payments") throw new Error(`Unexpected table ${table}`);
      return {
        select: () => ({
          limit: async () => ({ data: options.visiblePayments ?? [], error: null }),
        }),
        insert: () => ({
          select: () => ({
            maybeSingle: async () =>
              options.insertSucceeds
                ? { data: { id: options.insertedId ?? "leaked-payment-1" }, error: null }
                : { data: null, error: { message: "new row violates row-level security policy" } },
          }),
        }),
      };
    },
    rpc: async () =>
      options.rpcRejects === false
        ? { data: [{ found_item: true, quantity_remaining: 0 }], error: null }
        : { data: [{ found_item: false }], error: null },
  };
}

beforeEach(() => {
  adminTable = new FakeTable();
});

describe("runPaymentsReadSuite", () => {
  it("passes (resolves with no refs) when every probe behaves safely", async () => {
    const ctx = makeCtx(
      makeSessionClient({
        visiblePayments: [{ studio_id: CONFIG.studioId }],
        rpcRejects: true,
        insertSucceeds: false,
      }),
    );
    const refs = await runPaymentsReadSuite(ctx);
    expect(refs).toEqual({});
  });

  it("throws a plain Error (no refs) when the tenant-isolation read leaks a foreign row", async () => {
    const ctx = makeCtx(
      makeSessionClient({
        visiblePayments: [{ studio_id: "some-other-studio" }],
        rpcRejects: true,
        insertSucceeds: false,
      }),
    );
    await expect(runPaymentsReadSuite(ctx)).rejects.toThrow(/outside the synthetic tenant/);
  });

  it("throws a plain Error when the deduction RPC does not safely reject a bogus reference", async () => {
    const ctx = makeCtx(
      makeSessionClient({
        visiblePayments: [],
        rpcRejects: false,
        insertSucceeds: false,
      }),
    );
    await expect(runPaymentsReadSuite(ctx)).rejects.toThrow(/did not safely reject/);
  });

  it("throws SuiteAssertionError carrying the leaked row id when the unauthorized write unexpectedly succeeds", async () => {
    const ctx = makeCtx(
      makeSessionClient({
        visiblePayments: [],
        rpcRejects: true,
        insertSucceeds: true,
        insertedId: "leaked-payment-42",
      }),
    );

    let caught: unknown;
    try {
      await runPaymentsReadSuite(ctx);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SuiteAssertionError);
    expect((caught as SuiteAssertionError).partialRecordRefs).toEqual({ payments: ["leaked-payment-42"] });
    expect((caught as SuiteAssertionError).message).toMatch(/NOT rejected/);
  });
});

describe("cleanupPaymentsReadSuite", () => {
  it("is not_required when there are no refs (the normal, expected case)", async () => {
    const ctx = makeCtx(makeSessionClient({}));
    const result = await cleanupPaymentsReadSuite(ctx, {});
    expect(result).toEqual({ status: "not_required", error: null });
  });

  it("removes the leaked row via the admin client when a payments ref is present", async () => {
    adminTable.rows.push({ id: "leaked-payment-42", studio_id: CONFIG.studioId, status: "pending" });
    // A row belonging to a different studio must survive -- cleanup is
    // still studio-scoped even when using the admin client.
    adminTable.rows.push({ id: "other-studio-row", studio_id: "some-other-studio", status: "pending" });
    const ctx = makeCtx(makeSessionClient({}));

    const result = await cleanupPaymentsReadSuite(ctx, { payments: ["leaked-payment-42"] });

    expect(result).toEqual({ status: "completed", error: null });
    expect(adminTable.rows.find((r) => r.id === "leaked-payment-42")).toBeUndefined();
    expect(adminTable.rows.find((r) => r.id === "other-studio-row")).toBeDefined();
  });
});
