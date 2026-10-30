import { NextResponse } from "next/server";
import { getCurrentUserProfile } from "@/lib/auth/platform";
import { getPlatformMfaStatus } from "@/lib/auth/platform-mfa";
import { buildPriceConfigReport } from "@/lib/billing-qa/priceConfigReport";

/**
 * BILLING-QA-4. GET /api/platform/billing/price-config -- read-only report of the studio Price IDs, pricing flags,
 * Stripe key modes and webhook-secret presence THIS deployment runs with (src/lib/billing-qa/priceConfigReport.ts).
 * No Stripe call and no write; the only reads are the caller's own profile and MFA status. Nothing secret in the
 * response.
 *
 * Dark: answers 404 unless BILLING_QA_PRICE_CONFIG_ENDPOINT is exactly "enabled" (checked before any auth lookup).
 * Then platform admins only -- everyone else gets the same 404 -- with the same bar as the /platform pages
 * (requirePlatformMfa): a verified TOTP factor and an AAL2 session. Every response is no-store.
 */

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

const notFound = () => new NextResponse("Not found", { status: 404, headers: NO_STORE });

export async function GET() {
  if (process.env.BILLING_QA_PRICE_CONFIG_ENDPOINT !== "enabled") return notFound();

  const profile = await getCurrentUserProfile();
  if (profile?.platform_role !== "platform_admin") return notFound();

  let mfa: Awaited<ReturnType<typeof getPlatformMfaStatus>>;
  try {
    mfa = await getPlatformMfaStatus();
  } catch {
    return NextResponse.json({ error: "platform_mfa_unavailable" }, { status: 503, headers: NO_STORE });
  }
  if (!mfa.hasVerifiedTotpFactor || mfa.currentLevel !== "aal2") {
    return NextResponse.json({ error: "platform_mfa_required" }, { status: 403, headers: NO_STORE });
  }

  try {
    return NextResponse.json(buildPriceConfigReport(process.env), { headers: NO_STORE });
  } catch {
    // The report builder refuses (e.g. it would have contained a secret): fail closed, never with the details.
    console.error("billing_price_config_report_refused");
    return NextResponse.json({ error: "report_refused" }, { status: 500, headers: NO_STORE });
  }
}
