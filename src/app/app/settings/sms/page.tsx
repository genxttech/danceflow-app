import Link from "next/link";
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
import SmsStatusTracker from "./SmsStatusTracker";

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

      <SmsStatusTracker state={status.state} textingOn={status.textingOn} />

      {creditView ? <SmsCreditPanel view={creditView} purchasesEnabled={smsCreditPurchasesEnabled()} returned={returned} /> : null}

      {creditView && limitView ? <SmsLimitPanel overview={limitView} isOwner={isOwner} enabled={smsMonthlyLimitsEnabled()} /> : null}

      {creditView && recurringView ? <SmsRecurringPanel overview={recurringView} prices={creditView.prices} isOwner={isOwner} enabled={smsRecurringAuthorizationEnabled()} /> : null}

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
          wizard
        ) : (
          <details className="rounded-2xl border border-slate-200 bg-white p-4">
            <summary className="cursor-pointer text-sm font-semibold text-violet-800">View the information on file</summary>
            <div className="mt-4">{wizard}</div>
          </details>
        )
      ) : null}

      {isOwner && status.canCancel ? <SmsCancelSetup submitted={status.state !== "draft"} /> : null}
    </div>
  );
}
