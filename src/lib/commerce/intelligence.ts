import type { SupabaseClient } from "@supabase/supabase-js";

type OrderRow = {
  id: string;
  order_number: string;
  status: string;
  payment_status: string;
  fulfillment_status: string;
  total: number | string | null;
  refund_total: number | string | null;
  created_at: string;
};

type OrderItemRow = {
  order_id: string;
  catalog_item_id: string | null;
  name_snapshot: string;
  quantity: number | null;
  line_total: number | string | null;
  fulfillment_status: string;
};

type CatalogRow = {
  id: string;
  name: string;
  item_type: string;
  active: boolean;
  published: boolean;
  marketplace_visible: boolean;
};

type EntitlementRow = {
  id: string;
  catalog_item_id: string;
  order_id: string | null;
  status: string;
  granted_at: string;
};

type ProgressRow = {
  entitlement_id: string;
  catalog_item_id: string;
  percent_complete: number | string | null;
  completed: boolean;
  last_watched_at: string | null;
};

type InventoryRow = {
  id: string;
  catalog_item_id: string;
  name: string;
  quantity_on_hand: number | null;
  reorder_threshold: number | null;
  active: boolean;
};

export type CommerceProductInsight = {
  catalogItemId: string | null;
  name: string;
  itemType: string;
  units: number;
  revenue: number;
};

export type CommerceContentInsight = {
  entitlementId: string;
  catalogItemId: string;
  name: string;
  percentComplete: number;
  completed: boolean;
  lastWatchedAt: string | null;
};

export type CommerceIntelligence = {
  orderCount: number;
  completedOrderCount: number;
  netRevenue: number;
  refunds: number;
  averageOrderValue: number;
  unfulfilledOrderCount: number;
  lowStockVariantCount: number;
  digitalEntitlementCount: number;
  digitalStartedCount: number;
  digitalCompletedCount: number;
  digitalNeverStartedCount: number;
  digitalLowCompletionCount: number;
  digitalStartRate: number;
  digitalCompletionRate: number;
  topProducts: CommerceProductInsight[];
  purchasedNeverStarted: CommerceContentInsight[];
  lowCompletionContent: CommerceContentInsight[];
  strongestSignal:
    | "fulfillment"
    | "inventory"
    | "never_started"
    | "low_completion"
    | "growth";
};

function amount(value: number | string | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function getCommerceIntelligence(input: {
  supabase: SupabaseClient;
  studioId: string;
  rangeStart?: string | null;
}): Promise<CommerceIntelligence> {
  let orderQuery = input.supabase
    .from("commerce_orders")
    .select(
      "id, order_number, status, payment_status, fulfillment_status, total, refund_total, created_at",
    )
    .eq("studio_id", input.studioId)
    .order("created_at", { ascending: false })
    .limit(2000);

  if (input.rangeStart) {
    orderQuery = orderQuery.gte("created_at", input.rangeStart);
  }

  const [
    ordersResult,
    orderItemsResult,
    catalogResult,
    entitlementsResult,
    progressResult,
    inventoryResult,
  ] = await Promise.all([
    orderQuery,
    input.supabase
      .from("commerce_order_items")
      .select(
        "order_id, catalog_item_id, name_snapshot, quantity, line_total, fulfillment_status",
      )
      .eq("studio_id", input.studioId)
      .limit(10000),
    input.supabase
      .from("commerce_catalog_items")
      .select(
        "id, name, item_type, active, published, marketplace_visible",
      )
      .eq("studio_id", input.studioId)
      .limit(5000),
    input.supabase
      .from("commerce_entitlements")
      .select("id, catalog_item_id, order_id, status, granted_at")
      .eq("studio_id", input.studioId)
      .in("status", ["active", "refunded_access_retained"])
      .limit(10000),
    input.supabase
      .from("commerce_playback_progress")
      .select(
        "entitlement_id, catalog_item_id, percent_complete, completed, last_watched_at",
      )
      .eq("studio_id", input.studioId)
      .limit(20000),
    input.supabase
      .from("commerce_product_variant_inventory")
      .select(
        "id, catalog_item_id, name, quantity_on_hand, reorder_threshold, active",
      )
      .eq("studio_id", input.studioId)
      .eq("active", true)
      .limit(5000),
  ]);

  const criticalErrors = [
    ["orders", ordersResult.error],
    ["order items", orderItemsResult.error],
    ["catalog", catalogResult.error],
    ["entitlements", entitlementsResult.error],
    ["playback progress", progressResult.error],
    ["inventory", inventoryResult.error],
  ] as const;

  const failed = criticalErrors.find(([, error]) => error);
  if (failed) {
    throw new Error(
      `Commerce intelligence failed to load ${failed[0]}: ${failed[1]?.message}`,
    );
  }

  const orders = (ordersResult.data ?? []) as OrderRow[];
  const orderIds = new Set(orders.map((order) => order.id));
  const orderById = new Map(orders.map((order) => [order.id, order]));
  const catalog = (catalogResult.data ?? []) as CatalogRow[];
  const catalogById = new Map(catalog.map((item) => [item.id, item]));
  const orderItems = ((orderItemsResult.data ?? []) as OrderItemRow[]).filter(
    (item) => orderIds.has(item.order_id),
  );
  const entitlements = (entitlementsResult.data ?? []) as EntitlementRow[];
  const progress = (progressResult.data ?? []) as ProgressRow[];
  const inventory = (inventoryResult.data ?? []) as InventoryRow[];

  const completedOrders = orders.filter(
    (order) =>
      order.status === "completed" &&
      ["paid", "partially_refunded", "refunded"].includes(order.payment_status),
  );
  const completedOrderIds = new Set(completedOrders.map((order) => order.id));
  const completedOrderItems = orderItems.filter((item) =>
    completedOrderIds.has(item.order_id),
  );

  const netRevenue = completedOrders.reduce(
    (sum, order) =>
      sum + amount(order.total) - amount(order.refund_total),
    0,
  );
  const refunds = completedOrders.reduce(
    (sum, order) => sum + amount(order.refund_total),
    0,
  );
  const unfulfilledOrderCount = orders.filter(
    (order) =>
      ["paid", "partially_refunded"].includes(order.payment_status) &&
      !["fulfilled", "not_required"].includes(order.fulfillment_status),
  ).length;

  const productMap = new Map<string, CommerceProductInsight>();
  for (const item of completedOrderItems) {
    const catalogItem = item.catalog_item_id
      ? catalogById.get(item.catalog_item_id)
      : null;
    const key = item.catalog_item_id ?? item.name_snapshot;
    const current = productMap.get(key) ?? {
      catalogItemId: item.catalog_item_id,
      name: item.name_snapshot,
      itemType: catalogItem?.item_type ?? "unknown",
      units: 0,
      revenue: 0,
    };

    current.units += Number(item.quantity ?? 0);
    current.revenue += amount(item.line_total);
    productMap.set(key, current);
  }

  const progressByEntitlement = new Map<string, ProgressRow[]>();
  for (const row of progress) {
    const current = progressByEntitlement.get(row.entitlement_id) ?? [];
    current.push(row);
    progressByEntitlement.set(row.entitlement_id, current);
  }

  const digitalInsights: CommerceContentInsight[] = entitlements
    .map((entitlement) => {
      const catalogItem = catalogById.get(entitlement.catalog_item_id);
      if (
        !catalogItem ||
        !["digital_video", "video_series"].includes(catalogItem.item_type)
      ) {
        return null;
      }

      const rows = progressByEntitlement.get(entitlement.id) ?? [];
      const mostRecent = [...rows].sort(
        (a, b) =>
          new Date(b.last_watched_at ?? 0).getTime() -
          new Date(a.last_watched_at ?? 0).getTime(),
      )[0];
      const averagePercent = rows.length
        ? rows.reduce(
            (sum, row) => sum + amount(row.percent_complete),
            0,
          ) / rows.length
        : 0;

      return {
        entitlementId: entitlement.id,
        catalogItemId: entitlement.catalog_item_id,
        name: catalogItem.name,
        percentComplete: Number(averagePercent.toFixed(1)),
        completed: rows.length > 0 && rows.every((row) => row.completed),
        lastWatchedAt: mostRecent?.last_watched_at ?? null,
      };
    })
    .filter((item): item is CommerceContentInsight => Boolean(item));

  const digitalStarted = digitalInsights.filter(
    (item) => item.lastWatchedAt !== null,
  );
  const digitalCompleted = digitalInsights.filter((item) => item.completed);
  const purchasedNeverStarted = digitalInsights
    .filter((item) => item.lastWatchedAt === null)
    .slice(0, 8);
  const lowCompletionContent = digitalInsights
    .filter(
      (item) =>
        item.lastWatchedAt !== null &&
        !item.completed &&
        item.percentComplete < 35,
    )
    .sort((a, b) => a.percentComplete - b.percentComplete)
    .slice(0, 8);

  const lowStockVariantCount = inventory.filter(
    (row) =>
      Number(row.quantity_on_hand ?? 0) <=
      Number(row.reorder_threshold ?? 0),
  ).length;

  const strongestSignal: CommerceIntelligence["strongestSignal"] =
    unfulfilledOrderCount > 0
      ? "fulfillment"
      : lowStockVariantCount > 0
        ? "inventory"
        : purchasedNeverStarted.length > 0
          ? "never_started"
          : lowCompletionContent.length > 0
            ? "low_completion"
            : "growth";

  return {
    orderCount: orders.length,
    completedOrderCount: completedOrders.length,
    netRevenue,
    refunds,
    averageOrderValue: completedOrders.length
      ? netRevenue / completedOrders.length
      : 0,
    unfulfilledOrderCount,
    lowStockVariantCount,
    digitalEntitlementCount: digitalInsights.length,
    digitalStartedCount: digitalStarted.length,
    digitalCompletedCount: digitalCompleted.length,
    digitalNeverStartedCount: purchasedNeverStarted.length,
    digitalLowCompletionCount: lowCompletionContent.length,
    digitalStartRate: digitalInsights.length
      ? (digitalStarted.length / digitalInsights.length) * 100
      : 0,
    digitalCompletionRate: digitalInsights.length
      ? (digitalCompleted.length / digitalInsights.length) * 100
      : 0,
    topProducts: Array.from(productMap.values())
      .sort((a, b) => b.revenue - a.revenue || b.units - a.units)
      .slice(0, 6),
    purchasedNeverStarted,
    lowCompletionContent,
    strongestSignal,
  };
}
