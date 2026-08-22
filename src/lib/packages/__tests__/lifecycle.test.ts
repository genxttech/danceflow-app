import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { reconcileClientPackageLifecycle } from "@/lib/packages/lifecycle";
import { getClientPackageStatus, resolveEligiblePackage } from "@/lib/packages/entitlement";
import {
  FakeTable,
  createFakeEntitlementClient,
  type Row,
} from "@/lib/packages/__tests__/fakeEntitlementSupabase";

const STUDIO_ID = "studio-1";
const CLIENT_ID = "client-1";

function table(rows: Row[]) {
  const t = new FakeTable();
  t.rows = rows;
  return t;
}

function buildClient(clientPackages: Row[], automationActions: Row[] = []) {
  const tables = {
    client_packages: table(clientPackages),
    automation_actions: table(automationActions),
    automation_action_events: table([]),
  };
  const fake = createFakeEntitlementClient(tables);
  return { fake: fake as unknown as SupabaseClient, tables };
}

describe("reconcileClientPackageLifecycle", () => {
  it("10. a package zeroed to no usable balance across all items is flipped to inactive", async () => {
    const { fake, tables } = buildClient([
      {
        id: "pkg-1",
        studio_id: STUDIO_ID,
        client_id: CLIENT_ID,
        active: true,
        client_package_items: [{ quantity_remaining: 0, is_unlimited: false }],
      },
    ]);

    const result = await reconcileClientPackageLifecycle({
      supabase: fake,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
      clientPackageId: "pkg-1",
    });

    expect(result.completedPackageIds).toEqual(["pkg-1"]);
    expect(tables.client_packages.rows[0].active).toBe(false);
  });

  it("a package with any unlimited item remains active even if finite items are exhausted (OR across items)", async () => {
    const { fake, tables } = buildClient([
      {
        id: "pkg-1",
        studio_id: STUDIO_ID,
        client_id: CLIENT_ID,
        active: true,
        client_package_items: [
          { quantity_remaining: 0, is_unlimited: false },
          { quantity_remaining: null, is_unlimited: true },
        ],
      },
    ]);

    const result = await reconcileClientPackageLifecycle({
      supabase: fake,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
      clientPackageId: "pkg-1",
    });

    expect(result.completedPackageIds).toEqual([]);
    expect(tables.client_packages.rows[0].active).toBe(true);
  });

  it("a package with remaining balance is left untouched", async () => {
    const { fake, tables } = buildClient([
      {
        id: "pkg-1",
        studio_id: STUDIO_ID,
        client_id: CLIENT_ID,
        active: true,
        client_package_items: [{ quantity_remaining: 3, is_unlimited: false }],
      },
    ]);

    await reconcileClientPackageLifecycle({
      supabase: fake,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
      clientPackageId: "pkg-1",
    });

    expect(tables.client_packages.rows[0].active).toBe(true);
  });

  it("13. a manually archived package (already active=false) is never touched or reactivated by reconciliation", async () => {
    const { fake, tables } = buildClient([
      {
        id: "pkg-1",
        studio_id: STUDIO_ID,
        client_id: CLIENT_ID,
        active: false,
        archived_at: "2026-09-01T00:00:00.000Z",
        archived_by: "user-1",
        archive_reason: "Client dispute",
        client_package_items: [{ quantity_remaining: 5, is_unlimited: false }],
      },
    ]);

    const result = await reconcileClientPackageLifecycle({
      supabase: fake,
      studioId: STUDIO_ID,
      clientId: CLIENT_ID,
      clientPackageId: "pkg-1",
    });

    // Reconciliation's own query excludes any row with archived_at set
    // (`.is("archived_at", null)`), so an already-archived package is never
    // even considered -- it can never be reactivated, deactivated further,
    // or have its archive metadata touched, regardless of its real balance.
    expect(result.completedPackageIds).toEqual([]);
    expect(tables.client_packages.rows[0]).toMatchObject({
      active: false,
      archived_at: "2026-09-01T00:00:00.000Z",
      archived_by: "user-1",
      archive_reason: "Client dispute",
    });
  });

  describe("Package Refund P0, Slice 2b: defensive refund-state normalization", () => {
    it("refund_status='full', active=true, balance>0 -> ends active=false", async () => {
      const { fake, tables } = buildClient([
        {
          id: "pkg-1",
          studio_id: STUDIO_ID,
          client_id: CLIENT_ID,
          active: true,
          archived_at: null,
          refund_status: "full",
          client_package_items: [{ quantity_remaining: 5, is_unlimited: false }],
        },
      ]);

      await reconcileClientPackageLifecycle({
        supabase: fake,
        studioId: STUDIO_ID,
        clientId: CLIENT_ID,
        clientPackageId: "pkg-1",
      });

      expect(tables.client_packages.rows[0]).toMatchObject({
        active: false,
        // Never altered: balance, refund state, archive metadata.
        client_package_items: [{ quantity_remaining: 5, is_unlimited: false }],
        refund_status: "full",
        archived_at: null,
      });
    });

    it("refund_status='partial', active=true -> ordinary behavior completely unchanged (not touched by the new block)", async () => {
      const { fake, tables } = buildClient([
        {
          id: "pkg-1",
          studio_id: STUDIO_ID,
          client_id: CLIENT_ID,
          active: true,
          archived_at: null,
          refund_status: "partial",
          client_package_items: [{ quantity_remaining: 5, is_unlimited: false }],
        },
      ]);

      await reconcileClientPackageLifecycle({
        supabase: fake,
        studioId: STUDIO_ID,
        clientId: CLIENT_ID,
        clientPackageId: "pkg-1",
      });

      // Real balance exists, so ordinary reconciliation leaves it active --
      // the new refund block never even considers this row.
      expect(tables.client_packages.rows[0].active).toBe(true);
    });

    it("refund_status='full', active=false (already correctly inactive) -> remains false, and is never simultaneously present in the reactivate branch", async () => {
      const { fake, tables } = buildClient([
        {
          id: "pkg-1",
          studio_id: STUDIO_ID,
          client_id: CLIENT_ID,
          active: false,
          archived_at: null,
          refund_status: "full",
          client_package_items: [{ quantity_remaining: 5, is_unlimited: false }],
        },
      ]);

      const result = await reconcileClientPackageLifecycle({
        supabase: fake,
        studioId: STUDIO_ID,
        clientId: CLIENT_ID,
        clientPackageId: "pkg-1",
      });

      // toReactivate excludes refund-blocked rows, and toDeactivateForRefund
      // only ever considers active!==false rows -- this row qualifies for
      // neither block, so nothing is written and it stays exactly as it was.
      expect(tables.client_packages.rows[0].active).toBe(false);
      expect(result.completedPackageIds).toEqual([]);
    });

    it("normalization never mutates client_package_items, archived_at, or refund_status itself", async () => {
      const { fake, tables } = buildClient([
        {
          id: "pkg-1",
          studio_id: STUDIO_ID,
          client_id: CLIENT_ID,
          active: true,
          archived_at: null,
          refund_status: "full",
          client_package_items: [
            { quantity_remaining: 3, is_unlimited: false },
            { quantity_remaining: 0, is_unlimited: false },
          ],
        },
      ]);

      await reconcileClientPackageLifecycle({
        supabase: fake,
        studioId: STUDIO_ID,
        clientId: CLIENT_ID,
        clientPackageId: "pkg-1",
      });

      const row = tables.client_packages.rows[0];
      expect(row.client_package_items).toEqual([
        { quantity_remaining: 3, is_unlimited: false },
        { quantity_remaining: 0, is_unlimited: false },
      ]);
      expect(row.archived_at).toBeNull();
      expect(row.refund_status).toBe("full");
    });
  });

  it("a database failure during reconciliation fails closed with a thrown error", async () => {
    const { fake, tables } = buildClient([]);
    tables.client_packages.forceError = { message: "connection reset" };

    await expect(
      reconcileClientPackageLifecycle({
        supabase: fake,
        studioId: STUDIO_ID,
        clientId: CLIENT_ID,
        clientPackageId: "pkg-1",
      }),
    ).rejects.toThrow(/could not reconcile package lifecycle/i);
  });

  describe("bidirectional reconciliation (Slice 1b-a blocking-review correction)", () => {
    it("active + debit to zero -> active=false (existing direction, reconfirmed)", async () => {
      const { fake, tables } = buildClient([
        {
          id: "pkg-1",
          studio_id: STUDIO_ID,
          client_id: CLIENT_ID,
          active: true,
          archived_at: null,
          client_package_items: [{ quantity_remaining: 0, is_unlimited: false }],
        },
      ]);

      const result = await reconcileClientPackageLifecycle({
        supabase: fake,
        studioId: STUDIO_ID,
        clientId: CLIENT_ID,
        clientPackageId: "pkg-1",
      });

      expect(result.completedPackageIds).toEqual(["pkg-1"]);
      expect(tables.client_packages.rows[0].active).toBe(false);
    });

    it("naturally depleted (active=false, archived_at=null) + credit restoring usable balance -> active=true", async () => {
      const { fake, tables } = buildClient([
        {
          id: "pkg-1",
          studio_id: STUDIO_ID,
          client_id: CLIENT_ID,
          active: false,
          archived_at: null,
          client_package_items: [{ quantity_remaining: 3, is_unlimited: false }],
        },
      ]);

      await reconcileClientPackageLifecycle({
        supabase: fake,
        studioId: STUDIO_ID,
        clientId: CLIENT_ID,
        clientPackageId: "pkg-1",
      });

      expect(tables.client_packages.rows[0].active).toBe(true);
    });

    it("manually archived (active=false, archived_at!=null) + credit restoring balance -> remains active=false", async () => {
      const { fake, tables } = buildClient([
        {
          id: "pkg-1",
          studio_id: STUDIO_ID,
          client_id: CLIENT_ID,
          active: false,
          archived_at: "2026-09-01T00:00:00.000Z",
          archived_by: "user-1",
          archive_reason: "Client dispute",
          client_package_items: [{ quantity_remaining: 5, is_unlimited: false }],
        },
      ]);

      await reconcileClientPackageLifecycle({
        supabase: fake,
        studioId: STUDIO_ID,
        clientId: CLIENT_ID,
        clientPackageId: "pkg-1",
      });

      // Real balance alone is not enough to reactivate an archived package
      // -- archive_at set means it's excluded from reconciliation entirely,
      // regardless of how much usable balance it now has.
      expect(tables.client_packages.rows[0].active).toBe(false);
    });

    it("an expired but non-archived package with restored usable balance becomes active=true again, while booking eligibility and staff-visible status still independently treat it as expired", async () => {
      const { fake, tables } = buildClient([
        {
          id: "pkg-1",
          studio_id: STUDIO_ID,
          client_id: CLIENT_ID,
          active: false,
          archived_at: null,
          expiration_date: "2020-01-01",
          client_package_items: [
            { usage_type: "private_lesson", quantity_remaining: 4, is_unlimited: false },
          ],
        },
      ]);

      await reconcileClientPackageLifecycle({
        supabase: fake,
        studioId: STUDIO_ID,
        clientId: CLIENT_ID,
        clientPackageId: "pkg-1",
      });

      // Reconciliation itself never reads expiration_date -- it correctly
      // restores `active` from real balance alone, the lifecycle signal.
      expect(tables.client_packages.rows[0].active).toBe(true);

      // Booking eligibility independently re-checks expiration and still
      // blocks it, regardless of `active` now being true.
      const eligibility = await resolveEligiblePackage({
        supabase: fake,
        studioId: STUDIO_ID,
        clientId: CLIENT_ID,
        appointmentType: "private_lesson",
        appointmentDateIso: "2026-09-01T10:00:00.000Z",
      });
      expect(eligibility.outcome).toBe("none_eligible");

      // The staff-visible status precedence independently checks
      // expiration too, and still shows "expired," not "active".
      const status = getClientPackageStatus({
        archived_at: tables.client_packages.rows[0].archived_at as string | null,
        expiration_date: tables.client_packages.rows[0].expiration_date as string | null,
        client_package_items: [{ quantity_remaining: 4, is_unlimited: false }],
      });
      expect(status).toBe("expired");
    });

    it("reactivation never clears or touches archive metadata fields", async () => {
      const { fake, tables } = buildClient([
        {
          id: "pkg-1",
          studio_id: STUDIO_ID,
          client_id: CLIENT_ID,
          active: false,
          archived_at: null,
          archived_by: null,
          archive_reason: null,
          client_package_items: [{ quantity_remaining: 2, is_unlimited: false }],
        },
      ]);

      await reconcileClientPackageLifecycle({
        supabase: fake,
        studioId: STUDIO_ID,
        clientId: CLIENT_ID,
        clientPackageId: "pkg-1",
      });

      expect(tables.client_packages.rows[0]).toMatchObject({
        active: true,
        archived_at: null,
        archived_by: null,
        archive_reason: null,
      });
    });

    it("ARIA stale-action cleanup only runs for the deactivation direction, never for reactivation", async () => {
      const { fake, tables } = buildClient(
        [
          {
            id: "pkg-restored",
            studio_id: STUDIO_ID,
            client_id: CLIENT_ID,
            active: false,
            archived_at: null,
            client_package_items: [{ quantity_remaining: 3, is_unlimited: false }],
          },
        ],
        [
          {
            id: "action-1",
            studio_id: STUDIO_ID,
            rule_key: "aria_low_package_balance",
            related_table: "client_packages",
            related_id: "pkg-restored",
            status: "suggested",
          },
        ],
      );

      const result = await reconcileClientPackageLifecycle({
        supabase: fake,
        studioId: STUDIO_ID,
        clientId: CLIENT_ID,
        clientPackageId: "pkg-restored",
      });

      expect(result.completedPackageIds).toEqual([]);
      expect(tables.client_packages.rows[0].active).toBe(true);
      // The stale ARIA action tied to the now-reactivated package must be
      // left exactly as it was -- reactivation must not "complete" it the
      // way deactivation does, since no existing product rule asks for
      // automation behavior on the restoration path.
      expect(tables.automation_actions.rows[0].status).toBe("suggested");
    });

    it("Package Refund P0, Slice 2b: a refund_status='full' package is never auto-reactivated even with restored balance", async () => {
      const { fake, tables } = buildClient([
        {
          id: "pkg-1",
          studio_id: STUDIO_ID,
          client_id: CLIENT_ID,
          active: false,
          archived_at: null,
          refund_status: "full",
          client_package_items: [{ quantity_remaining: 5, is_unlimited: false }],
        },
      ]);

      await reconcileClientPackageLifecycle({
        supabase: fake,
        studioId: STUDIO_ID,
        clientId: CLIENT_ID,
        clientPackageId: "pkg-1",
      });

      expect(tables.client_packages.rows[0].active).toBe(false);
    });

    it("both directions apply correctly within a single multi-package client reconciliation pass", async () => {
      const { fake, tables } = buildClient([
        {
          id: "pkg-to-deactivate",
          studio_id: STUDIO_ID,
          client_id: CLIENT_ID,
          active: true,
          archived_at: null,
          client_package_items: [{ quantity_remaining: 0, is_unlimited: false }],
        },
        {
          id: "pkg-to-reactivate",
          studio_id: STUDIO_ID,
          client_id: CLIENT_ID,
          active: false,
          archived_at: null,
          client_package_items: [{ quantity_remaining: 5, is_unlimited: false }],
        },
        {
          id: "pkg-archived-untouched",
          studio_id: STUDIO_ID,
          client_id: CLIENT_ID,
          active: false,
          archived_at: "2026-09-01T00:00:00.000Z",
          client_package_items: [{ quantity_remaining: 5, is_unlimited: false }],
        },
      ]);

      const result = await reconcileClientPackageLifecycle({
        supabase: fake,
        studioId: STUDIO_ID,
        clientId: CLIENT_ID,
      });

      expect(result.completedPackageIds).toEqual(["pkg-to-deactivate"]);
      const byId = Object.fromEntries(tables.client_packages.rows.map((r) => [r.id, r]));
      expect(byId["pkg-to-deactivate"].active).toBe(false);
      expect(byId["pkg-to-reactivate"].active).toBe(true);
      expect(byId["pkg-archived-untouched"].active).toBe(false);
    });
  });
});
