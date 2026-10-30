/**
 * D7-4 (R36): fail-closed protection for subscriptions with grandfathered or
 * contractual terms (the $129/month Pro first).
 *
 * A protected studio never starts a new Checkout (no new trial, no new Founder
 * price, no new 12-month policy) and is routed to support, whatever the Stripe
 * status of its subscription (canceled included). Two signals, either is enough:
 *   1. registry: an unreleased `protected_subscriptions` row for the studio
 *      (the authority; populated by an owner-approved step, never by this code);
 *   2. legacy-price backstop: any subscription of the studio's own customer, in
 *      any status, that carries a configured legacy protected Price. The backstop
 *      only ever BLOCKS a checkout; it never grants or changes anything.
 */

export const PROTECTED_REGISTRY_TABLE = "protected_subscriptions";

export type SubscriptionSnapshot = {
  id?: string | null;
  status: string;
  priceIds: string[];
};

export type ProtectionReason = "registry" | "legacy_price";

export type ProtectionResult = {
  protected: boolean;
  reasons: ProtectionReason[];
};

export type RegistryLoad =
  | { status: "ok"; activeRows: number; customerIds: string[] }
  // The table does not exist yet (migration not applied): the price backstop still applies.
  | { status: "table_missing" }
  // Anything else is unknown: callers must fail closed.
  | { status: "error" };

/** Legacy protected Price ids from env (comma-separated allowed); empty when unset. */
export function legacyProtectedPriceIds(
  env: Record<string, string | undefined> = process.env,
): string[] {
  // A legacy id that equals a CURRENT Founder or standard Price would block every normal
  // customer on that plan, so such ids are dropped (the registry still protects).
  const current = new Set(
    Object.entries(env)
      .filter(([key]) => /^STRIPE_PRICE_(STUDIO|ORGANIZER)_(.+_)?(FOUNDER|STANDARD)$/.test(key))
      .map(([, value]) => (value ?? "").trim())
      .filter(Boolean),
  );

  return (env.STRIPE_PRICE_STUDIO_PRO_FOUNDER_LEGACY ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((id) => !current.has(id));
}

export function evaluateProtection(params: {
  registry: RegistryLoad;
  subscriptions: SubscriptionSnapshot[];
  legacyPriceIds: string[];
}): ProtectionResult {
  const reasons: ProtectionReason[] = [];

  if (params.registry.status === "ok" && params.registry.activeRows > 0) {
    reasons.push("registry");
  }

  if (
    params.legacyPriceIds.length > 0 &&
    params.subscriptions.some((subscription) =>
      subscription.priceIds.some((priceId) => params.legacyPriceIds.includes(priceId)),
    )
  ) {
    reasons.push("legacy_price");
  }

  return { protected: reasons.length > 0, reasons };
}

type RegistryRead = PromiseLike<{
  data: Array<{ released_at?: string | null; stripe_customer_id?: string | null }> | null;
  error: { code?: string; message?: string } | null;
}>;

type RegistryClient = {
  from: (table: string) => {
    select: (columns: string) => { eq: (column: string, value: string) => RegistryRead };
  };
};

const MISSING_TABLE_CODES = new Set(["42P01", "PGRST205"]);

export async function loadProtectedRegistry(
  admin: RegistryClient,
  studioId: string,
): Promise<RegistryLoad> {
  const { data, error } = await admin
    .from(PROTECTED_REGISTRY_TABLE)
    .select("released_at, stripe_customer_id")
    .eq("studio_id", studioId);

  if (error) {
    return MISSING_TABLE_CODES.has(error.code ?? "") ? { status: "table_missing" } : { status: "error" };
  }

  if (!Array.isArray(data)) return { status: "error" };

  const active = data.filter((row) => !row.released_at);

  return {
    status: "ok",
    activeRows: active.length,
    // Customers named by the registry are inspected too (a replaced customer must not hide a legacy subscription).
    customerIds: active
      .map((row) => row.stripe_customer_id)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  };
}
