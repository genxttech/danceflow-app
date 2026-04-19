import { createAdminClient } from "@/lib/supabase/admin";

type LeadActivityRow = {
  id: string;
  studio_id: string;
  client_id: string | null;
  note: string;
  follow_up_due_at: string | null;
  clients:
    | { first_name: string; last_name: string }
    | { first_name: string; last_name: string }[]
    | null;
};

type ClientPackageItemRow = {
  quantity_remaining: number | null;
  is_unlimited: boolean;
};

type ClientPackageRow = {
  id: string;
  studio_id: string;
  client_id: string | null;
  name_snapshot: string;
  client_package_items: ClientPackageItemRow[];
  clients:
    | { first_name: string; last_name: string }
    | { first_name: string; last_name: string }[]
    | null;
};

type FloorRentalRow = {
  id: string;
  studio_id: string;
  client_id: string | null;
  starts_at: string;
  ends_at: string;
  title: string | null;
  status: string;
  clients:
    | { first_name: string; last_name: string }
    | { first_name: string; last_name: string }[]
    | null;
};

type ExistingNotificationRow = {
  lead_activity_id?: string | null;
  client_package_id?: string | null;
  appointment_id?: string | null;
};

type StudioNotificationSettingsRow = {
  public_intro_booking_enabled: boolean;
  follow_up_overdue_enabled: boolean;
  package_low_balance_enabled: boolean;
  package_depleted_enabled: boolean;
  floor_rental_upcoming_enabled: boolean;
};

function fmtDateTime(value: string) {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function getClientName(
  value:
    | { first_name: string; last_name: string }
    | { first_name: string; last_name: string }[]
    | null
) {
  const client = Array.isArray(value) ? value[0] : value;
  return client ? `${client.first_name} ${client.last_name}` : "Client";
}

function normalizePackageName(value: string | null | undefined) {
  const trimmed = (value ?? "").trim();
  return trimmed || "Package";
}

function normalizeRentalTitle(value: string | null | undefined) {
  const trimmed = (value ?? "").trim();
  return trimmed || "Floor Space Rental";
}

function hasDepletedFiniteBalance(items: ClientPackageItemRow[]) {
  return items.some(
    (item) =>
      !item.is_unlimited &&
      item.quantity_remaining !== null &&
      item.quantity_remaining <= 0
  );
}

function hasLowFiniteBalance(items: ClientPackageItemRow[]) {
  return items.some(
    (item) =>
      !item.is_unlimited &&
      item.quantity_remaining !== null &&
      item.quantity_remaining > 0 &&
      item.quantity_remaining <= 2
  );
}

async function insertNotifications(
  supabase: ReturnType<typeof createAdminClient>,
  rows: Record<string, unknown>[]
) {
  if (rows.length === 0) return 0;

  const { error } = await supabase.from("notifications").insert(rows);

  if (error) {
    throw new Error(error.message);
  }

  return rows.length;
}

export async function syncStudioNotifications(studioId: string) {
  const supabase = createAdminClient();
  const now = new Date();
  const nowIso = now.toISOString();
  const next24HoursIso = new Date(
    now.getTime() + 24 * 60 * 60 * 1000
  ).toISOString();

  const [
    { data: settingsRow, error: settingsError },
    { data: overdueFollowUps, error: overdueError },
    { data: packageRows, error: packageRowsError },
    { data: floorRentalRows, error: floorRentalRowsError },
    { data: existingFollowUpNotifications, error: existingFollowUpNotificationsError },
    { data: existingPackageDepletedNotifications, error: existingPackageDepletedNotificationsError },
    { data: existingPackageLowBalanceNotifications, error: existingPackageLowBalanceNotificationsError },
    { data: existingFloorRentalNotifications, error: existingFloorRentalNotificationsError },
  ] = await Promise.all([
    supabase
      .from("studio_notification_settings")
      .select(`
        public_intro_booking_enabled,
        follow_up_overdue_enabled,
        package_low_balance_enabled,
        package_depleted_enabled,
        floor_rental_upcoming_enabled
      `)
      .eq("studio_id", studioId)
      .maybeSingle(),

    supabase
      .from("lead_activities")
      .select(`
        id,
        studio_id,
        client_id,
        note,
        follow_up_due_at,
        clients (
          first_name,
          last_name
        )
      `)
      .eq("studio_id", studioId)
      .not("follow_up_due_at", "is", null)
      .is("completed_at", null)
      .lt("follow_up_due_at", nowIso),

    supabase
      .from("client_packages")
      .select(`
        id,
        studio_id,
        client_id,
        name_snapshot,
        client_package_items (
          quantity_remaining,
          is_unlimited
        ),
        clients (
          first_name,
          last_name
        )
      `)
      .eq("studio_id", studioId)
      .eq("active", true),

    supabase
      .from("appointments")
      .select(`
        id,
        studio_id,
        client_id,
        starts_at,
        ends_at,
        title,
        status,
        clients:clients!appointments_client_id_fkey (
          first_name,
          last_name
        )
      `)
      .eq("studio_id", studioId)
      .eq("appointment_type", "floor_space_rental")
      .eq("status", "scheduled")
      .gte("starts_at", nowIso)
      .lt("starts_at", next24HoursIso)
      .order("starts_at", { ascending: true }),

    supabase
      .from("notifications")
      .select("lead_activity_id")
      .eq("studio_id", studioId)
      .eq("type", "follow_up_overdue")
      .not("lead_activity_id", "is", null),

    supabase
      .from("notifications")
      .select("client_package_id")
      .eq("studio_id", studioId)
      .eq("type", "package_depleted")
      .not("client_package_id", "is", null),

    supabase
      .from("notifications")
      .select("client_package_id")
      .eq("studio_id", studioId)
      .eq("type", "package_low_balance")
      .not("client_package_id", "is", null),

    supabase
      .from("notifications")
      .select("appointment_id")
      .eq("studio_id", studioId)
      .eq("type", "floor_rental_upcoming")
      .not("appointment_id", "is", null),
  ]);

  if (settingsError) {
    throw new Error(
      `Failed to load notification settings for sync: ${settingsError.message}`
    );
  }

  if (overdueError) {
    throw new Error(
      `Failed to load overdue follow-ups for notification sync: ${overdueError.message}`
    );
  }

  if (packageRowsError) {
    throw new Error(
      `Failed to load client packages for notification sync: ${packageRowsError.message}`
    );
  }

  if (floorRentalRowsError) {
    throw new Error(
      `Failed to load floor rentals for notification sync: ${floorRentalRowsError.message}`
    );
  }

  if (existingFollowUpNotificationsError) {
    throw new Error(
      `Failed to load existing follow-up notifications: ${existingFollowUpNotificationsError.message}`
    );
  }

  if (existingPackageDepletedNotificationsError) {
    throw new Error(
      `Failed to load existing depleted package notifications: ${existingPackageDepletedNotificationsError.message}`
    );
  }

  if (existingPackageLowBalanceNotificationsError) {
    throw new Error(
      `Failed to load existing low balance notifications: ${existingPackageLowBalanceNotificationsError.message}`
    );
  }

  if (existingFloorRentalNotificationsError) {
    throw new Error(
      `Failed to load existing floor rental notifications: ${existingFloorRentalNotificationsError.message}`
    );
  }

  const settings: StudioNotificationSettingsRow = settingsRow ?? {
    public_intro_booking_enabled: true,
    follow_up_overdue_enabled: true,
    package_low_balance_enabled: true,
    package_depleted_enabled: true,
    floor_rental_upcoming_enabled: true,
  };

  const typedFollowUps = (overdueFollowUps ?? []) as LeadActivityRow[];
  const typedPackages = (packageRows ?? []) as ClientPackageRow[];
  const typedFloorRentals = (floorRentalRows ?? []) as FloorRentalRow[];

  const existingFollowUpIds = new Set(
    ((existingFollowUpNotifications ?? []) as ExistingNotificationRow[])
      .map((row) => row.lead_activity_id)
      .filter(Boolean)
  );

  const existingPackageDepletedIds = new Set(
    ((existingPackageDepletedNotifications ?? []) as ExistingNotificationRow[])
      .map((row) => row.client_package_id)
      .filter(Boolean)
  );

  const existingPackageLowBalanceIds = new Set(
    ((existingPackageLowBalanceNotifications ?? []) as ExistingNotificationRow[])
      .map((row) => row.client_package_id)
      .filter(Boolean)
  );

  const existingFloorRentalAppointmentIds = new Set(
    ((existingFloorRentalNotifications ?? []) as ExistingNotificationRow[])
      .map((row) => row.appointment_id)
      .filter(Boolean)
  );

  const followUpNotificationsToInsert = settings.follow_up_overdue_enabled
    ? typedFollowUps
        .filter((activity) => !existingFollowUpIds.has(activity.id))
        .map((activity) => {
          const clientName = getClientName(activity.clients);

          return {
            studio_id: studioId,
            type: "follow_up_overdue",
            title: `${clientName} — Overdue follow-up`,
            body: [
              activity.follow_up_due_at
                ? `Follow-up was due ${fmtDateTime(activity.follow_up_due_at)}.`
                : null,
              activity.note ? `Note: ${activity.note}` : null,
            ]
              .filter(Boolean)
              .join(" "),
            client_id: activity.client_id,
            lead_activity_id: activity.id,
          };
        })
    : [];

  const packageDepletedNotificationsToInsert = settings.package_depleted_enabled
    ? typedPackages
        .filter((pkg) => hasDepletedFiniteBalance(pkg.client_package_items ?? []))
        .filter((pkg) => !existingPackageDepletedIds.has(pkg.id))
        .map((pkg) => {
          const clientName = getClientName(pkg.clients);
          const packageName = normalizePackageName(pkg.name_snapshot);

          return {
            studio_id: studioId,
            type: "package_depleted",
            title: `${clientName} — ${packageName} depleted`,
            body: `Package "${packageName}" has no remaining balance in at least one finite item.`,
            client_id: pkg.client_id,
            client_package_id: pkg.id,
          };
        })
    : [];

  const packageLowBalanceNotificationsToInsert = settings.package_low_balance_enabled
    ? typedPackages
        .filter((pkg) => !hasDepletedFiniteBalance(pkg.client_package_items ?? []))
        .filter((pkg) => hasLowFiniteBalance(pkg.client_package_items ?? []))
        .filter((pkg) => !existingPackageLowBalanceIds.has(pkg.id))
        .map((pkg) => {
          const clientName = getClientName(pkg.clients);
          const packageName = normalizePackageName(pkg.name_snapshot);

          return {
            studio_id: studioId,
            type: "package_low_balance",
            title: `${clientName} — ${packageName} low balance`,
            body: `Package "${packageName}" is running low and has 2 or fewer remaining in at least one finite item.`,
            client_id: pkg.client_id,
            client_package_id: pkg.id,
          };
        })
    : [];

  const floorRentalNotificationsToInsert = settings.floor_rental_upcoming_enabled
    ? typedFloorRentals
        .filter((rental) => !existingFloorRentalAppointmentIds.has(rental.id))
        .map((rental) => {
          const clientName = getClientName(rental.clients);
          const rentalTitle = normalizeRentalTitle(rental.title);

          return {
            studio_id: studioId,
            type: "floor_rental_upcoming",
            title: `${clientName} — Upcoming floor rental`,
            body: `${rentalTitle} starts ${fmtDateTime(
              rental.starts_at
            )}. No room reservation or package deduction applies.`,
            client_id: rental.client_id,
            appointment_id: rental.id,
          };
        })
    : [];

  let insertedCount = 0;

  insertedCount += await insertNotifications(
    supabase,
    followUpNotificationsToInsert
  );

  insertedCount += await insertNotifications(
    supabase,
    packageDepletedNotificationsToInsert
  );

  insertedCount += await insertNotifications(
    supabase,
    packageLowBalanceNotificationsToInsert
  );

  insertedCount += await insertNotifications(
    supabase,
    floorRentalNotificationsToInsert
  );

  return { insertedCount };
}