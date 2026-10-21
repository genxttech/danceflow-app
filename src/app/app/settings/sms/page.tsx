import Link from "next/link";
import { ChevronDown, ChevronRight } from "lucide-react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { canManageSettings } from "@/lib/auth/permissions";
import { getOnboardingDraft, getStudioSmsStatus, type OnboardingDraft, type StudioSmsStatus } from "@/lib/sms/onboarding/client";
import { emptyDraft, prefillDraft, type DraftFields } from "@/lib/sms/onboarding/fields";
import { buildCampaignPackage } from "@/lib/sms/onboarding/campaignTemplate";
import { getSmsCreditView } from "@/lib/billing/smsCreditView";
import { smsCreditPurchasesEnabled } from "@/lib/billing/smsCreditPurchases";
import SmsCancelSetup from "./SmsCancelSetup";
import { getRecurringOverview, smsRecurringAuthorizationEnabled } from "@/lib/billing/smsRecurring";
import SmsCreditPanel from "./SmsCreditPanel";
import { getMonthlyLimitOverview, smsMonthlyLimitsEnabled } from "@/lib/billing/smsMonthlyLimits";
import SmsLimitPanel from "./SmsLimitPanel";
import SmsRecurringPanel from "./SmsRecurringPanel";
import SmsSetupWizard from "./SmsSetupWizard";
import SmsJourney from "./SmsJourney";
import { hasLiveCampaignAuthorization, type FinanceFacts } from "@/lib/sms/provisioning/journey";
import { getOwnerProvisioning } from "@/lib/sms/provisioning/ownerRead";

const EDIT_STATES = new Set(["not_started", "draft", "needs_info"]);

function appOrigin() {
  return (process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_SITE_URL || "https://idanceflow.com").replace(/\/$/, "");
}

export default async function SmsSettingsPage({ searchParams }: { searchParams?: Promise<Record<string, string | undefined>> }) {
  const query = (await searchParams) ?? {};
  const returned = query.credit === "success" || query.credit === "cancelled" ? query.credit : null;
  const context = await getCurrentStudioContext();

  // Settings managers only; the page does not exist for anyone else, nor for studios the pilot flag is off for.
  if (!canManageSettings(context.studioRole)) redirect("/app");

  const supabase = await createClient();
  let status: StudioSmsStatus;
  try {
    status = await getStudioSmsStatus(supabase, context.studioId);
  } catch {
    redirect("/app/settings");
  }
  if (!status.available) redirect("/app/settings");

  const isOwner = status.role === "studio_owner";
  // Prepaid credit: the database returns it only to an owner or administrator of this studio, and only for this studio's legal business.
  let creditView: Awaited<ReturnType<typeof getSmsCreditView>> = null;
  try {
    creditView = await getSmsCreditView(supabase, context.studioId);
  } catch {
    creditView = null;
  }
  // Recurring service charges: read through the same user session; a failure only hides the card
  let recurringView: Awaited<ReturnType<typeof getRecurringOverview>> = null;
  if (creditView) {
    try {
      recurringView = await getRecurringOverview(supabase, context.studioId);
    } catch {
      recurringView = null;
    }
  }
  // Monthly spending limit: read through the same user session; a failure only hides the card
  let limitView: Awaited<ReturnType<typeof getMonthlyLimitOverview>> = null;
  if (creditView) {
    try {
      limitView = await getMonthlyLimitOverview(supabase, context.studioId);
    } catch {
      limitView = null;
    }
  }
  // Paused: a platform admin switched the pilot off after this setup started. The setup stays visible (status only) and the
  // owner can still cancel; the draft RPC is switch-gated, so nothing else is fetched.
  const paused = status.paused;
  let draft: OnboardingDraft | null = null;
  if (!paused) {
    try {
      draft = await getOnboardingDraft(supabase, context.studioId);
    } catch {
      draft = null; // platform admins view the tracker only
    }
  }

  const { data: studio } = await supabase
    .from("studios")
    .select("name, public_name, slug, address_line_1, address_line_2, city, state, postal_code, public_phone, public_website_url")
    .eq("id", context.studioId)
    .maybeSingle();

  let initial: DraftFields = emptyDraft();
  if (draft) {
    initial = draft.fields;
  } else if (isOwner && studio) {
    const { data: profile } = await supabase.from("profiles").select("full_name, email").eq("id", context.userId).maybeSingle();
    initial = prefillDraft(studio, profile ?? {});
  }

  const displayName = String(studio?.public_name || studio?.name || "Your dance studio");
  const campaign = buildCampaignPackage({ displayName, origin: appOrigin(), slug: String(studio?.slug ?? "") });
  const canEdit = isOwner && !paused && status.canEdit && EDIT_STATES.has(status.state);
  // TW-4F: an owner of a location not yet linked to a legal business can attest it belongs to an existing one (the location page and the database
  // re-check the owner role and refuse a linked location or a second pending request)
  const offerLocationLink = isOwner && !paused && creditView?.overview.legalBusiness !== true;

  // R2c-I2: campaign / Messaging Service status from the database, bound to this user's session (null = unreadable or not installed: the journey then says "not available yet")
  const provisioning = !paused && isOwner ? await getOwnerProvisioning(supabase, context.studioId) : null;
  const campaignKind = recurringView?.campaignMonthlyKind ?? null;
  const finance: FinanceFacts | null = creditView
    ? {
        legalBusiness: creditView.overview.legalBusiness,
        availableCents: creditView.overview.availableCents,
        onHold: creditView.overview.onHold,
        pilotBusiness: recurringView?.pilotBusiness ?? creditView.overview.pilotCeilingCents != null,
        campaignMonthlyKind: campaignKind,
        hasActiveAuthorization: hasLiveCampaignAuthorization(recurringView?.authorizations, campaignKind),
        prices: creditView.prices.map((p) => ({ kind: p.kind, customerPriceCents: p.customerPriceCents })),
        purchasesOpen: smsCreditPurchasesEnabled(),
        authorizationOpen: smsRecurringAuthorizationEnabled() && recurringView != null,
      }
    : null;

  const wizard = (
    <SmsSetupWizard
      // keyed by state only: a successful save must not remount the form (it would drop the "Saved." confirmation)
      key={status.state}
      initial={initial}
      einOnFile={draft?.einOnFile ?? false}
      einLast4={draft?.einLast4 ?? null}
      canEdit={canEdit}
      highlightFields={status.needsInfoFields}
      campaign={{
        description: campaign.description,
        samples: campaign.samples,
        termsUrl: campaign.termsUrl,
        privacyUrl: campaign.privacyUrl,
        optInPageUrl: campaign.optInPageUrl,
      }}
    />
  );

  return (
    <div className="space-y-6 bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.08),transparent_28%),radial-gradient(circle_at_top_right,rgba(124,58,237,0.09),transparent_26%)] p-1">
      <section className="overflow-hidden rounded-[30px] border border-violet-200 bg-white shadow-sm">
        <div className="bg-[linear-gradient(135deg,#111827_0%,#4c1d95_52%,#f97316_145%)] px-6 py-7 text-white">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-orange-200">Studio Operations</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">Texting</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-white/80">
            Turn on appointment texts for your clients: confirmations, changes and cancellations, plus one-to-one messages from your team.
            Texts go only to people who opted in. No marketing.
          </p>
        </div>
      </section>

      <div className="flex justify-end">
        <Link href="/app/settings" className="text-sm font-semibold text-violet-700 hover:text-violet-900">Back to settings</Link>
      </div>

      <SmsJourney
        state={status.state}
        textingOn={status.textingOn}
        paused={paused}
        isOwner={isOwner}
        finance={finance}
        canEditForm={canEdit}
        // campaign status comes from the session-bound read; number, sender and compliance stay "not available yet" until the authoritative R2b reads exist
        provisioning={provisioning}
      />

      {offerLocationLink ? (
        <section aria-labelledby="sms-location-link-heading" className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 sm:flex-row sm:items-center sm:justify-between" data-testid="sms-location-link">
          <div>
            <h2 id="sms-location-link-heading" className="text-sm font-semibold text-slate-900">Another location of a business already texting with DanceFlow?</h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Link this studio to that legal business instead of starting a new setup. Locations share one texting registration, setup budget and prepaid balance. DanceFlow verifies it first.
            </p>
          </div>
          <Link href="/app/settings/sms/location" className="inline-flex shrink-0 items-center justify-center gap-1 rounded-xl border border-violet-300 px-4 py-2 text-sm font-semibold text-violet-800 hover:bg-violet-50">
            Link this location
            <ChevronRight aria-hidden="true" className="h-4 w-4" />
          </Link>
        </section>
      ) : null}

      {creditView ? <div id="sms-credit"><SmsCreditPanel view={creditView} purchasesEnabled={smsCreditPurchasesEnabled()} returned={returned} /></div> : null}

      {creditView && limitView ? <SmsLimitPanel overview={limitView} isOwner={isOwner} enabled={smsMonthlyLimitsEnabled()} /> : null}

      {creditView && recurringView ? <div id="sms-recurring"><SmsRecurringPanel overview={recurringView} prices={creditView.prices} isOwner={isOwner} enabled={smsRecurringAuthorizationEnabled()} /></div> : null}

      {paused ? (
        <p role="status" className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Texting setup is paused for your studio. Your saved information is kept and nothing is needed from you right now.
          {isOwner && status.canCancel ? " You can cancel the setup below if you no longer want it." : ""}
        </p>
      ) : null}

      {!isOwner ? (
        <p className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">Only the studio owner can change this setup. You can follow its progress here.</p>
      ) : null}

      {!paused && (isOwner || draft) ? (
        canEdit ? (
          <div id="sms-setup">{wizard}</div>
        ) : (
          <details className="group/onfile rounded-2xl border border-slate-200 bg-white p-4">
            <summary className="flex cursor-pointer list-none items-center gap-1 text-sm font-semibold text-violet-800 [&::-webkit-details-marker]:hidden">
              <ChevronDown aria-hidden="true" className="h-4 w-4 transition-transform group-open/onfile:rotate-180" />
              View the information on file
            </summary>
            <div className="mt-4">{wizard}</div>
          </details>
        )
      ) : null}

      {isOwner && status.canCancel ? <SmsCancelSetup submitted={status.state !== "draft"} /> : null}
    </div>
  );
}
