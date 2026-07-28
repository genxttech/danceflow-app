export const SQUARE_SOURCE_SYSTEM = "square" as const;

export const SQUARE_COMMERCE_IMPORT_TYPES = [
  "products",
  "inventory",
  "retail_orders",
] as const;

export type SquareCommerceImportType =
  (typeof SQUARE_COMMERCE_IMPORT_TYPES)[number];

export type SquareMatchStrategy =
  | "source_external_id"
  | "sku"
  | "barcode"
  | "manual_decision";

export const SQUARE_PRODUCT_MATCH_PRECEDENCE: readonly SquareMatchStrategy[] = [
  "source_external_id",
  "sku",
  "barcode",
  "manual_decision",
];

export const SQUARE_VARIANT_MATCH_PRECEDENCE =
  SQUARE_PRODUCT_MATCH_PRECEDENCE;

export const SQUARE_CUSTOMER_MATCH_PRECEDENCE = [
  "source_external_id",
  "normalized_email",
  "normalized_phone",
  "manual_decision",
] as const;

export const SQUARE_COMMERCE_STAGE_ORDER = [
  {
    key: "products",
    sequenceNumber: 30,
    dependsOn: [] as const,
    executionStatus: "supported",
  },
  {
    key: "inventory",
    sequenceNumber: 40,
    dependsOn: ["products"] as const,
    executionStatus: "supported",
  },
  {
    key: "retail_orders",
    sequenceNumber: 90,
    dependsOn: ["clients", "products", "payments"] as const,
    executionStatus: "assisted",
  },
] as const;

export const SQUARE_COMMERCE_EXCEPTION_CODES = [
  "duplicate_sku",
  "duplicate_barcode",
  "source_identity_conflict",
  "multiple_customer_matches",
  "product_missing_variation",
  "variation_missing_price",
  "unsupported_currency",
  "negative_inventory",
  "multiple_inventory_locations",
  "unmatched_order_customer",
  "unmatched_order_product",
  "refund_exceeds_paid_amount",
  "payment_order_amount_mismatch",
  "digital_buyer_not_linked",
  "digital_content_not_configured",
  "duplicate_active_entitlement",
] as const;

export type SquareCommerceExceptionCode =
  (typeof SQUARE_COMMERCE_EXCEPTION_CODES)[number];

export const SQUARE_ACCOUNTING_IMPORT_DEFAULT = {
  accountingSyncMode: "deferred",
  historicalImport: true,
} as const;

export function normalizeSquareCurrency(value: unknown) {
  const currency = String(value ?? "usd").trim().toLowerCase();
  return /^[a-z]{3}$/.test(currency) ? currency : null;
}

export function normalizeSquareSku(value: unknown) {
  const sku = String(value ?? "").trim();
  return sku.length > 0 ? sku.slice(0, 80) : null;
}

export function normalizeSquareBarcode(value: unknown) {
  const barcode = String(value ?? "").trim();
  return barcode.length > 0 ? barcode.slice(0, 120) : null;
}

export function squareMoneyToDecimal(
  amountMinorUnits: unknown,
  decimalPlaces = 2,
) {
  const amount = Number(amountMinorUnits);
  if (!Number.isSafeInteger(amount)) return null;

  const divisor = 10 ** decimalPlaces;
  return Math.round((amount / divisor) * 100) / 100;
}

export function buildSquareSourceMetadata(params: {
  objectType: string;
  sourceExternalId: string;
  version?: number | null;
  locationIds?: string[];
  raw?: Record<string, unknown>;
}) {
  return {
    source: "square_import",
    square_object_type: params.objectType,
    square_external_id: params.sourceExternalId,
    square_version: params.version ?? null,
    square_location_ids: params.locationIds ?? [],
    square_source_snapshot: params.raw ?? {},
  };
}
