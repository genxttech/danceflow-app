import { beforeEach, describe, expect, it, vi } from "vitest";

const createAdminClient = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => createAdminClient(),
}));

import { syncStudioNotifications } from "@/lib/notifications/sync";
import {
  FakeTable,
  createFakeEntitlementClient,
  type Row,
} from "@/lib/packages/__tests__/fakeEntitlementSupabase";

const STUDIO_ID = "studio-1";

function buildClient(clientPackageRows: Row[]) {
  const studios = new FakeTable();
  studios.rows = [{ id: STUDIO_ID, timezone: "America/New_York" }];

  const studio_notification_settings = new FakeTable();
  studio_notification_settings.rows = [
    {
      studio_id: STUDIO_ID,
      public_intro_booking_enabled: true,
      follow_up_overdue_enabled: true,
      package_low_balance_enabled: true,
      package_depleted_enabled: true,
      floor_rental_upcoming_enabled: true,
    },
  ];

  const lead_activities = new FakeTable();
  lead_activities.rows = [];

  const client_packages = new FakeTable();
  client_packages.rows = clientPackageRows;

  const appointments = new FakeTable();
  appointments.rows = [];

  const notifications = new FakeTable();
  notifications.rows = [];

  const tables = {
    studios,
    studio_notification_settings,
    lead_activities,
    client_packages,
    appointments,
    notifications,
  };

  const fake = createFakeEntitlementClient(tables);
  return { fake, tables };
}

function pkg(overrides: Row = {}): Row {
  return {
    id: "pkg-low",
    studio_id: STUDIO_ID,
    client_id: "client-1",
    name_snapshot: "5-Lesson Package",
    active: true,
    clients: { first_name: "Ada", last_name: "Lovelace" },
    client_package_items: [
      { usage_type: "private_lesson", quantity_remaining: 1, is_unlimited: false },
    ],
    ...overrides,
  };
}

describe("syncStudioNotifications package warnings (Slice 1b-b canonical + suppression)", () => {
  beforeEach(() => {
    createAdminClient.mockReset();
  });

  it("low package, no replacement -> package_low_balance notification created", async () => {
    const { fake, tables } = buildClient([pkg()]);
    createAdminClient.mockReturnValue(fake);

    const result = await syncStudioNotifications(STUDIO_ID);

    expect(result.insertedCount).toBe(1);
    expect(tables.notifications.rows).toHaveLength(1);
    expect(tables.notifications.rows[0].type).toBe("package_low_balance");
    expect(tables.notifications.rows[0].client_package_id).toBe("pkg-low");
  });

  it("low package + healthy same-usage replacement -> no notification (suppressed)", async () => {
    const { fake, tables } = buildClient([
      pkg(),
      pkg({
        id: "pkg-replacement",
        client_package_items: [
          { usage_type: "private_lesson", quantity_remaining: 5, is_unlimited: false },
        ],
      }),
    ]);
    createAdminClient.mockReturnValue(fake);

    const result = await syncStudioNotifications(STUDIO_ID);

    expect(result.insertedCount).toBe(0);
    expect(tables.notifications.rows).toHaveLength(0);
  });

  it("depleted package, no replacement -> package_depleted notification, not low_balance", async () => {
    const { fake, tables } = buildClient([
      pkg({
        client_package_items: [
          { usage_type: "private_lesson", quantity_remaining: 0, is_unlimited: false },
        ],
      }),
    ]);
    createAdminClient.mockReturnValue(fake);

    await syncStudioNotifications(STUDIO_ID);

    expect(tables.notifications.rows).toHaveLength(1);
    expect(tables.notifications.rows[0].type).toBe("package_depleted");
  });

  it("depleted package + healthy same-usage replacement -> no notification (suppressed)", async () => {
    const { fake, tables } = buildClient([
      pkg({
        client_package_items: [
          { usage_type: "private_lesson", quantity_remaining: 0, is_unlimited: false },
        ],
      }),
      pkg({
        id: "pkg-replacement",
        client_package_items: [
          { usage_type: "private_lesson", quantity_remaining: 5, is_unlimited: false },
        ],
      }),
    ]);
    createAdminClient.mockReturnValue(fake);

    await syncStudioNotifications(STUDIO_ID);

    expect(tables.notifications.rows).toHaveLength(0);
  });

  it("a healthy replacement for an unrelated usage type does not suppress", async () => {
    const { fake, tables } = buildClient([
      pkg(),
      pkg({
        id: "pkg-replacement",
        client_package_items: [
          { usage_type: "group_class", quantity_remaining: 5, is_unlimited: false },
        ],
      }),
    ]);
    createAdminClient.mockReturnValue(fake);

    await syncStudioNotifications(STUDIO_ID);

    expect(tables.notifications.rows).toHaveLength(1);
    expect(tables.notifications.rows[0].type).toBe("package_low_balance");
  });

  it("an unlimited same-usage replacement suppresses the warning", async () => {
    const { fake, tables } = buildClient([
      pkg(),
      pkg({
        id: "pkg-replacement",
        client_package_items: [
          { usage_type: "private_lesson", quantity_remaining: null, is_unlimited: true },
        ],
      }),
    ]);
    createAdminClient.mockReturnValue(fake);

    await syncStudioNotifications(STUDIO_ID);

    expect(tables.notifications.rows).toHaveLength(0);
  });
});
