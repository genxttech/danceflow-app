import { NextResponse } from "next/server";

/**
 * Single source of truth for whether the Gusto integration is active.
 * Gusto is being removed as an active/customer-visible product integration
 * while its implementation, database objects, and any stored connection
 * state are preserved for possible future reactivation. Flip this back to
 * `true` (and restore the customer-visible entry points that read it) to
 * reactivate -- no other code in this file needs to change.
 */
export const GUSTO_INTEGRATION_ENABLED = false;

/**
 * Redirect `status` query-param value used by every dormant Gusto server
 * action. Deliberately generic -- callers must never branch this value (or
 * any other signal) on whether a studio ever had a Gusto connection.
 */
export const GUSTO_DORMANT_STATUS = "gusto_not_available";

/**
 * Response for the two Gusto OAuth API routes when the integration is
 * dormant. Identical regardless of any existing connection/credential
 * state for the requesting studio -- never inspects that state at all.
 */
export function gustoDormantRouteResponse() {
  return NextResponse.json(
    { error: "This integration is not currently available." },
    { status: 404 },
  );
}
