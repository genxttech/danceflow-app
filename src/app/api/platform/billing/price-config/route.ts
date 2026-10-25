import { NextResponse } from "next/server";
import { getCurrentUserProfile } from "@/lib/auth/platform";
import { getPlatformMfaStatus } from "@/lib/auth/platform-mfa";
import { buildPriceConfigReport } from "@/lib/billing-qa/priceConfigReport";

/**
 * BILLING-QA-4. GET /api/platform/billing/price-config -- read-only report of the studio Price IDs, pricing flags,
 * Stripe key modes and webhook-secret presence THIS deployment runs with (src/lib/billing-qa/priceConfigReport.ts).
 * No Stripe call, no database write, nothing secret in the response.
 *
 * Dark: answers 404 unless BILLING_QA_PRICE_CONFIG_ENDPOINT is exactly "enabled". Then platform admins only (anyone
 * else also gets 404, so the endpoint is not discoverable), with a TOTP-verified (AAL2) session, the same bar as the
 * /platform pages.
 */

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

const notFound = () => new NextResponse("Not found", { status: 404, headers: NO_STORE });

export async function GET() {
  if (process.env.BILLING_QA_PRICE_CONFIG_ENDPOINT !== "enabled") return notFound();

  const profile = await getCurrentUserProfile();
  if (profile?.platform_role !== "platform_admin") return notFound();

  let assuranceLevel: string | null;
  try {
    assuranceLevel = (await getPlatformMfaStatus()).currentLevel;
  } catch {
    return NextResponse.json({ error: "platform_mfa_unavailable" }, { status: 503, headers: NO_STORE });
  }
  if (assuranceLevel !== "aal2") {
    return NextResponse.json({ error: "platform_mfa_required" }, { status: 403, headers: NO_STORE });
  }

  return NextResponse.json(buildPriceConfigReport(process.env), { headers: NO_STORE });
}
