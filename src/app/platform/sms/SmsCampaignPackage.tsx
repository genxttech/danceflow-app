import { buildCampaignPackage } from "@/lib/sms/onboarding/campaignTemplate";
import { renderCampaignPackageText, reviewCampaignPackage } from "@/lib/sms/onboarding/campaignPackageReview";

/**
 * TW-4F-2a: read-only campaign package for a studio, for the platform admin to check and copy into the Twilio pre-submission review
 * request (plan decision D6). Built only from the studio's public name, its slug and the DanceFlow template. It sends nothing, calls
 * nothing and offers no action. No EIN, address, representative or Twilio identifier is involved.
 */
export default function SmsCampaignPackage({ studioName, publicName, slug, origin }: { studioName: string | null; publicName: string | null; slug: string | null; origin: string }) {
  const displayName = String(publicName || studioName || "").trim();
  const pkg = buildCampaignPackage({ displayName, origin, slug: String(slug ?? "") });
  const review = reviewCampaignPackage(pkg, { displayName, slug: String(slug ?? "") });
  const text = renderCampaignPackageText(pkg, { displayName: displayName || "Your dance studio" });
  const failed = review.checks.filter((item) => !item.ok);
  return (
    <details className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700" data-testid="sms-campaign-package">
      <summary className="cursor-pointer select-none font-semibold text-slate-800">
        Campaign package for Twilio pre-review {review.ok ? "(all checks pass)" : `(${failed.length} check${failed.length === 1 ? "" : "s"} to fix)`}
      </summary>
      <p className="mt-2 text-slate-500">Read-only. Nothing is sent to Twilio from here. Copy the text below into the pre-submission review request.</p>
      <ul className="mt-2 space-y-0.5">
        {review.checks.map((item) => (
          <li key={item.id} className={item.ok ? "text-emerald-800" : "font-semibold text-rose-800"}>
            {item.ok ? "Pass" : "Fix"}: {item.label}
            <span className="font-normal text-slate-500"> ({item.detail})</span>
          </li>
        ))}
      </ul>
      <label className="mt-3 block font-semibold text-slate-800">
        Package text
        <textarea readOnly rows={14} defaultValue={text} className="mt-1 w-full rounded border border-slate-300 bg-white p-2 font-mono text-[11px] font-normal text-slate-800" />
      </label>
    </details>
  );
}
