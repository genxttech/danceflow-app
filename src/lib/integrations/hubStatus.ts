/**
 * Status derivation for the Studio Integration Hub cards, kept pure so every provider's mapping is tested in one place.
 * Providers keep their own tables and clients; this module only turns a connection row into the hub badge.
 */
export type IntegrationStatus = "connected" | "attention" | "available" | "locked" | "coming_soon";

/** Connection states that mean "the studio has to act" (reconnect or fix), not "never connected". */
const NEEDS_ACTION_STATUSES = new Set(["needs_reauth", "reauthorization_required", "error"]);

export function isNeedsActionStatus(status: string | null | undefined) {
  return NEEDS_ACTION_STATUSES.has(String(status ?? ""));
}

export function stripeHubStatus(studio: {
  stripe_connected_account_id: string | null;
  stripe_connect_onboarding_complete: boolean | null;
  stripe_connect_charges_enabled: boolean | null;
  stripe_connect_payouts_enabled: boolean | null;
} | null | undefined): IntegrationStatus {
  if (!studio?.stripe_connected_account_id) return "available";
  const ready = Boolean(studio.stripe_connect_onboarding_complete && studio.stripe_connect_charges_enabled && studio.stripe_connect_payouts_enabled);
  return ready ? "connected" : "attention";
}

/** Wave needs the write scope to post; a connection without it must be reauthorized. */
export function waveNeedsReauthorization(connection: { status: string | null; scopes: string[] | null } | null | undefined) {
  if (!connection) return false;
  if (isNeedsActionStatus(connection.status)) return true;
  return connection.status === "connected" && !connection.scopes?.includes("transaction:write");
}

export function waveHubStatus(featureAvailable: boolean, connection: { status: string | null; wave_business_id: string | null; scopes: string[] | null } | null | undefined): IntegrationStatus {
  if (!featureAvailable) return "locked";
  if (!connection) return "available";
  if (waveNeedsReauthorization(connection)) return "attention";
  if (connection.status === "connected") return connection.wave_business_id ? "connected" : "attention";
  return "available";
}

export function googleHubStatus(connection: { status: string | null; last_sync_status: string | null; last_sync_error: string | null } | null | undefined): IntegrationStatus {
  if (!connection) return "available";
  if (connection.status === "connected") return connection.last_sync_status === "failed" || connection.last_sync_error ? "attention" : "connected";
  return isNeedsActionStatus(connection.status) ? "attention" : "available";
}

export function gustoHubStatus(connection: { status: string | null; last_health_status: string | null; last_error: string | null } | null | undefined): IntegrationStatus {
  if (!connection) return "available";
  if (connection.status === "connected") return connection.last_health_status === "failed" || connection.last_error ? "attention" : "connected";
  return isNeedsActionStatus(connection.status) ? "attention" : "available";
}
