import Link from "next/link";
import { redirect } from "next/navigation";
import type { ComponentType } from "react";
import {
  ArrowRight,
  CreditCard,
  ShieldCheck,
  Sparkles,
  Wallet,
} from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { getStripe } from "@/lib/payments/stripe";
import {
  BILLING_PLANS,
  formatPlanMoney,
  getBillingPlan,
  type BillingPlan,
  type PlanAudience,
  type PlanCode,
} from "@/lib/billing/plans";
import {
  getUsageAllowance,
  type UsageAllowanceResult,
} from "@/lib/usage/addons";
import {
  getActiveAiCreditPackEntitlementsForStudio,
  getAiCreditPacks,
  syncAiCreditPackEntitlementsForStudio,
  type ActiveAiCreditPackEntitlement,
  type AiCreditPack,
} from "@/lib/usage/ai-credit-packs";

type OrganizerSuiteEntitlement = {
  id: string;
  status: string | null;
  stripe_subscription_item_id: string | null;
};

type StudioBillingRow = {
  id: string;
  name: string | null;
  subscription_status: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_connected_account_id: string | null;
  stripe_connect_details_submitted: boolean | null;
  stripe_connect_charges_enabled: boolean | null;
  stripe_connect_payouts_enabled: boolean | null;
  stripe_connect_onboarding_complete: boolean | null;
};

type TerminalLocationRow = {
  id: string;
  stripe_location_id: string;
  display_name: string;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  active: boolean | null;
  created_at: string;
};

type TerminalReaderRow = {
  id: string;
  terminal_location_id: string | null;
  stripe_reader_id: string;
  label: string | null;
  device_type: string | null;
  status: string | null;
  ip_address: string | null;
  last_seen_at: string | null;
  active: boolean | null;
  created_at: string;
};

type SubscriptionRow = {
  status: string | null;
  subscription_plans:
    | { code: string | null }
    | { code: string | null }[]
    | null;
};

type StudioConnectReadiness = {
  connectedAccountId: string | null;
  detailsSubmitted: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  onboardingComplete: boolean;
  cardPaymentsEnabled: boolean;
  transfersEnabled: boolean;
  currentlyDue: string[];
  eventuallyDue: string[];
  pendingVerification: string[];
  disabledReason: string | null;
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function parseSingleSearchParam(
  value: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" ? value : undefined;
}

function getBillingReason(value?: string) {
  if (value === "access_paused") {
    return value;
  }

  return "default";
}

function isPlanCode(value: string | undefined): value is PlanCode {
  return (
    value === "starter" ||
    value === "growth" ||
    value === "pro" ||
    value === "organizer"
  );
}

function isAudience(value: string | undefined): value is PlanAudience {
  return value === "studio" || value === "organizer";
}

function canManageBilling(
  role: string | null | undefined,
  isPlatformAdminRole: boolean,
) {
  if (isPlatformAdminRole) return true;
  return role === "studio_owner" || role === "organizer_owner";
}

function getAudienceFromRole(role: string | null | undefined): PlanAudience {
  return role === "organizer_owner" || role === "organizer_admin"
    ? "organizer"
    : "studio";
}

function formatStripeRequirementLabel(value: string) {
  return value.replaceAll(".", " → ").replaceAll("_", " ");
}

function badgeClasses(
  tone: "green" | "yellow" | "red" | "slate" | "violet" | "sky",
) {
  switch (tone) {
    case "green":
      return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200";
    case "yellow":
      return "bg-amber-50 text-amber-700 ring-1 ring-amber-200";
    case "red":
      return "bg-rose-50 text-rose-700 ring-1 ring-rose-200";
    case "violet":
      return "bg-violet-50 text-violet-700 ring-1 ring-violet-200";
    case "sky":
      return "bg-sky-50 text-sky-700 ring-1 ring-sky-200";
    default:
      return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
  }
}

function getSubscriptionTone(
  status: string | null,
): "green" | "yellow" | "red" | "slate" {
  if (status === "active" || status === "trialing") return "green";
  if (status === "past_due" || status === "incomplete") return "yellow";
  if (status === "canceled" || status === "unpaid") return "red";
  return "slate";
}

function getSubscriptionLabel(status: string | null) {
  switch (status) {
    case "trialing":
      return "Trial";
    case "active":
      return "Subscribed";
    case "canceled":
      return "Canceled";
    case "past_due":
      return "Past due";
    case "incomplete":
      return "Incomplete";
    case "unpaid":
      return "Unpaid";
    default:
      return "Not started";
  }
}

function getCurrentPlanCode(row: SubscriptionRow | null) {
  if (!row) return null;
  const plan = Array.isArray(row.subscription_plans)
    ? row.subscription_plans[0]
    : row.subscription_plans;
  return plan?.code ?? null;
}

function getEntryMode(value?: string) {
  if (
    value === "trial-complete" ||
    value === "chooser" ||
    value === "no-card-trial"
  ) {
    return value;
  }
  return "default";
}

function getPostTrialDashboardPath(audience: PlanAudience) {
  return audience === "organizer" ? "/app/events" : "/app";
}

function getWorkspaceTone(audience: PlanAudience) {
  return audience === "organizer" ? "violet" : "sky";
}

function getWorkspaceTitle(audience: PlanAudience) {
  return audience === "organizer" ? "Organizer billing" : "Studio billing";
}

function getConnectStatus(connect: StudioConnectReadiness) {
  if (!connect.connectedAccountId) {
    return {
      label: "Not connected",
      tone: "slate" as const,
      description:
        "Connect Stripe so this workspace can accept payments and receive payouts.",
      buttonLabel: "Connect Stripe",
    };
  }

  if (
    connect.onboardingComplete &&
    connect.chargesEnabled &&
    connect.payoutsEnabled &&
    connect.cardPaymentsEnabled &&
    connect.transfersEnabled
  ) {
    return {
      label: "Ready",
      tone: "green" as const,
      description: "Stripe payouts are connected and ready for payment flows.",
      buttonLabel: "Update payout details",
    };
  }

  if (connect.detailsSubmitted) {
    return {
      label: "Action required",
      tone: "yellow" as const,
      description:
        "Stripe still needs additional information or capability approval.",
      buttonLabel: "Continue onboarding",
    };
  }

  return {
    label: "In progress",
    tone: "yellow" as const,
    description: "Finish the payout onboarding flow to enable money movement.",
    buttonLabel: "Continue onboarding",
  };
}

function getSuccessMessage(
  success?: string,
  audience?: PlanAudience,
): { title: string; body: string; tone: "green" | "sky" | "violet" } | null {
  if (!success) return null;

  if (success === "subscription_checkout_started") {
    return {
      title: "Checkout opened",
      body:
        audience === "organizer"
          ? "Complete billing setup to begin your organizer trial."
          : "Complete billing setup to begin your studio trial.",
      tone: audience === "organizer" ? "violet" : "sky",
    };
  }

  if (success === "manage_subscription") {
    return {
      title: "Billing portal opened",
      body: "You were redirected to manage your existing subscription.",
      tone: "green",
    };
  }

  if (success === "current_plan") {
    return {
      title: "Already on this plan",
      body: "This workspace is already on that plan. Use subscription management to make changes.",
      tone: "green",
    };
  }

  if (success === "stripe_connected") {
    return {
      title: "Stripe connected",
      body: "Your payout account is now connected to this workspace.",
      tone: "green",
    };
  }

  if (success === "ai_pack_added") {
    return {
      title: "AI credits added",
      body: "Your monthly AI allowance has been updated for this workspace.",
      tone: "green",
    };
  }

  if (success === "ai_pack_current") {
    return {
      title: "AI pack already active",
      body: "That AI credit pack is already connected to this workspace.",
      tone: "green",
    };
  }

  if (success === "organizer_suite_added") {
    return {
      title: "Organizer Suite added",
      body: "Ticketing, QR check-in, event settlement, organizer campaigns, and event ARIA are now available for this studio workspace.",
      tone: "green",
    };
  }

  if (success === "organizer_suite_current") {
    return {
      title: "Organizer Suite already active",
      body: "This studio workspace already has the Organizer Suite add-on.",
      tone: "green",
    };
  }

  if (success === "organizer_suite_removed") {
    return {
      title: "Organizer Suite removed",
      body: "The add-on was removed from this studio workspace. Basic public event listings remain available with the studio plan.",
      tone: "green",
    };
  }

  if (
    success === "terminal_location_created" ||
    success === "terminal_location_ready"
  ) {
    return {
      title: "Card reader location ready",
      body: "The front desk Terminal location is ready for in-person card reader setup.",
      tone: "green",
    };
  }

  if (success === "terminal_reader_registered") {
    return {
      title: "Card reader registered",
      body: "The reader was added to this workspace. Refresh status before the first test payment.",
      tone: "green",
    };
  }

  if (success === "terminal_readers_synced") {
    return {
      title: "Card readers refreshed",
      body: "Reader status was refreshed from Stripe.",
      tone: "green",
    };
  }

  return null;
}

function getErrorMessage(error?: string) {
  if (!error) return null;

  const messages: Record<string, string> = {
    plan_not_found: "The selected billing plan could not be found.",
    checkout_failed: "Billing checkout could not be started.",
    checkout_cancelled: "Billing checkout was canceled.",
    studio_not_found: "The current workspace could not be loaded.",
    no_studio_context: "No active workspace was selected for billing.",
    missing_price_id: "The selected plan is missing a Stripe price ID.",
    connect_failed: "Stripe onboarding could not be started.",
    ai_pack_not_found: "That AI credit pack could not be found.",
    ai_pack_missing_price: "This AI credit pack is not ready for checkout yet.",
    ai_pack_subscription_required:
      "Start or reactivate your subscription before adding AI credits.",
    ai_pack_add_failed: "The AI credit pack could not be added.",
    ai_pack_checkout_failed: "AI credit pack checkout could not be completed.",
    organizer_suite_not_found:
      "The Organizer Suite add-on could not be found for this workspace.",
    organizer_suite_missing_price:
      "The Organizer Suite add-on is missing a Stripe price ID.",
    organizer_suite_subscription_required:
      "Start or reactivate your studio subscription before adding Organizer Suite.",
    organizer_suite_checkout_failed:
      "Organizer Suite checkout could not be completed.",
    organizer_suite_remove_failed: "Organizer Suite could not be removed.",
    billing_access_denied:
      "Only a workspace owner or admin can manage billing add-ons.",
    terminal_stripe_not_connected:
      "Connect Stripe payouts before setting up in-person card readers.",
    terminal_stripe_not_ready:
      "Stripe still needs to finish payment capability approval before card readers can be set up.",
    terminal_location_missing_address:
      "Add the studio address in Settings before creating a card reader location.",
    terminal_location_lookup_failed:
      "Could not check the current card reader location.",
    terminal_location_save_failed:
      "The card reader location was created in Stripe but could not be saved in DanceFlow.",
    terminal_location_failed: "Card reader location setup failed.",
    terminal_location_required:
      "Create a card reader location before registering a reader.",
    terminal_reader_missing_code:
      "Enter the reader registration code shown on the Stripe reader.",
    terminal_reader_save_failed:
      "The reader was registered in Stripe but could not be saved in DanceFlow.",
    terminal_reader_failed: "Card reader registration failed.",
    terminal_reader_sync_failed:
      "Card reader status could not be refreshed from Stripe.",
  };

  return messages[error] ?? "Something went wrong while loading billing.";
}

function isManagedSubscriptionStatus(status: string | null | undefined) {
  return ["active", "trialing", "past_due", "unpaid"].includes(status ?? "");
}

function InfoCard({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: string;
  icon: ComponentType<{ className?: string }>;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <p className="text-sm text-slate-500">{label}</p>
          <p className="mt-1 text-lg font-semibold text-slate-950">{value}</p>
        </div>
      </div>
    </div>
  );
}

function getUsagePercent(allowance: UsageAllowanceResult) {
  if (allowance.totalAllowance <= 0) return 0;
  return Math.min(
    100,
    Math.round((allowance.quantityUsed / allowance.totalAllowance) * 100),
  );
}

function terminalReaderStatusClass(status: string | null | undefined) {
  const normalized = (status ?? "").toLowerCase();
  if (normalized === "online")
    return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200";
  if (normalized === "offline")
    return "bg-slate-100 text-slate-700 ring-1 ring-slate-200";
  return "bg-amber-50 text-amber-700 ring-1 ring-amber-200";
}

function terminalReaderStatusLabel(status: string | null | undefined) {
  if (!status) return "Unknown";
  return status.replaceAll("_", " ");
}

function formatTerminalDateTime(value: string | null) {
  if (!value) return "Not synced yet";
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function TerminalReadersCard({
  connectReadiness,
  locations,
  readers,
  canManage,
}: {
  connectReadiness: StudioConnectReadiness;
  locations: TerminalLocationRow[];
  readers: TerminalReaderRow[];
  canManage: boolean;
}) {
  const stripeReady = Boolean(
    connectReadiness.connectedAccountId &&
    connectReadiness.chargesEnabled &&
    connectReadiness.cardPaymentsEnabled,
  );
  const primaryLocation = locations[0] ?? null;
  const canRegisterReader =
    canManage && stripeReady && Boolean(primaryLocation);

  return (
    <div className="rounded-[32px] border border-slate-200 bg-white p-7 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
          <CreditCard className="h-5 w-5" />
        </div>

        <div className="min-w-0">
          <p className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
            In-person payments
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <h2 className="text-2xl font-semibold text-slate-950">
              In-person payments & card readers
            </h2>
            <span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-amber-700 ring-1 ring-amber-200">
              Beta
            </span>
          </div>
          <p className="mt-2 text-sm leading-7 text-slate-600">
            Set up supported physical Stripe Terminal smart readers for
            DanceFlow-initiated front desk payments, including Quick Charge,
            packages, memberships, lessons, and balances.
          </p>
        </div>
      </div>

      <div className="mt-6 rounded-2xl border border-indigo-200 bg-indigo-50 p-4 text-sm leading-6 text-indigo-900">
        DanceFlow-started card payments require a supported physical Stripe
        Terminal reader such as Stripe Reader S700/S710 or BBPOS WisePOS E.
        Stripe Dashboard mobile Tap to Pay is a separate fallback workflow and
        cannot be used as the reader for a DanceFlow-started payment.
      </div>

      {!stripeReady ? (
        <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          Connect Stripe and complete card payment approval before adding
          readers.
        </div>
      ) : null}

      <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-slate-950">
              Terminal location
            </p>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              {primaryLocation
                ? `${primaryLocation.display_name}${primaryLocation.city ? ` · ${primaryLocation.city}${primaryLocation.state ? `, ${primaryLocation.state}` : ""}` : ""}`
                : "Create a front desk location before registering readers."}
            </p>
          </div>

          {primaryLocation ? (
            <span className="inline-flex w-fit rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700 ring-1 ring-emerald-200">
              Ready
            </span>
          ) : (
            <form action="/api/stripe/terminal/location" method="post">
              <button
                type="submit"
                disabled={!canManage || !stripeReady}
                className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                Create Location
              </button>
            </form>
          )}
        </div>
      </div>

      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-slate-950">
            Registered readers
          </p>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            {readers.length > 0
              ? `${readers.length} reader${readers.length === 1 ? "" : "s"} connected to this workspace.`
              : "No readers registered yet."}
          </p>
        </div>

        <form action="/api/stripe/terminal/readers/sync" method="post">
          <button
            type="submit"
            disabled={!canManage || !stripeReady}
            className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-800 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Refresh Status
          </button>
        </form>
      </div>

      {readers.length > 0 ? (
        <div className="mt-4 space-y-3">
          {readers.map((reader) => (
            <div
              key={reader.id}
              className="rounded-2xl border border-slate-200 bg-white p-4"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="font-semibold text-slate-950">
                    {reader.label ?? "Card reader"}
                  </p>
                  <p className="mt-1 text-xs font-medium text-slate-500">
                    {reader.device_type?.replaceAll("_", " ") ?? "Reader"} ·
                    Last synced {formatTerminalDateTime(reader.last_seen_at)}
                  </p>
                </div>

                <span
                  className={`inline-flex w-fit rounded-full px-3 py-1 text-xs font-medium capitalize ${terminalReaderStatusClass(reader.status)}`}
                >
                  {terminalReaderStatusLabel(reader.status)}
                </span>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <details className="mt-6 rounded-2xl border border-slate-200 bg-slate-50">
        <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold text-slate-900 [&::-webkit-details-marker]:hidden">
          Register a reader
        </summary>
        <form
          action="/api/stripe/terminal/readers/register"
          method="post"
          className="space-y-4 border-t border-slate-200 p-4"
        >
          <input
            type="hidden"
            name="terminalLocationId"
            value={primaryLocation?.id ?? ""}
          />

          <div>
            <label
              htmlFor="readerLabel"
              className="text-sm font-medium text-slate-700"
            >
              Reader label
            </label>
            <input
              id="readerLabel"
              name="readerLabel"
              type="text"
              placeholder="Front desk reader"
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary-soft)]"
            />
          </div>

          <div>
            <label
              htmlFor="registrationCode"
              className="text-sm font-medium text-slate-700"
            >
              Reader registration code
            </label>
            <input
              id="registrationCode"
              name="registrationCode"
              type="text"
              placeholder="Shown on the Stripe reader"
              required
              className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-[var(--brand-primary)] focus:ring-2 focus:ring-[var(--brand-primary-soft)]"
            />
            <p className="mt-2 text-xs leading-5 text-slate-500">
              Use the registration code displayed on the physical reader during
              setup. Registering the reader connects it to this studio workspace
              for DanceFlow-started payments.
            </p>
          </div>

          <button
            type="submit"
            disabled={!canRegisterReader}
            className="w-full rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            Register Reader
          </button>
        </form>
      </details>
    </div>
  );
}

function UsageAllowanceCard({
  allowance,
  packs = [],
  activePacks = [],
  canManageAddOns = false,
  hasManagedSubscription = false,
}: {
  allowance: UsageAllowanceResult;
  packs?: AiCreditPack[];
  activePacks?: ActiveAiCreditPackEntitlement[];
  canManageAddOns?: boolean;
  hasManagedSubscription?: boolean;
}) {
  const percentUsed = getUsagePercent(allowance);
  const remaining = Math.max(
    0,
    allowance.totalAllowance - allowance.quantityUsed,
  );
  const hasIncludedUsage = allowance.totalAllowance > 0;

  return (
    <div className="rounded-[32px] border border-slate-200 bg-white p-7 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
          <Sparkles className="h-5 w-5" />
        </div>

        <div className="min-w-0">
          <p className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
            AI Usage
          </p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-950">
            Monthly AI actions
          </h2>
          <p className="mt-2 text-sm leading-7 text-slate-600">
            Track how many included AI writing and insight actions this
            workspace has used this month.
          </p>
        </div>
      </div>

      <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4">
        {hasIncludedUsage ? (
          <>
            <div className="flex items-end justify-between gap-4">
              <div>
                <p className="text-sm text-slate-500">Remaining this month</p>
                <p className="mt-1 text-2xl font-semibold text-slate-950">
                  {remaining.toLocaleString()}
                </p>
              </div>

              <div className="text-right">
                <p className="text-sm text-slate-500">Used</p>
                <p className="mt-1 text-sm font-semibold text-slate-800">
                  {allowance.quantityUsed.toLocaleString()} /{" "}
                  {allowance.totalAllowance.toLocaleString()}
                </p>
              </div>
            </div>

            <div className="mt-4 h-2 overflow-hidden rounded-full bg-white ring-1 ring-slate-200">
              <div
                className="h-full rounded-full bg-[var(--brand-primary)]"
                style={{ width: `${percentUsed}%` }}
              />
            </div>

            <p className="mt-3 text-xs leading-5 text-slate-500">
              Included: {allowance.includedAllowance.toLocaleString()}
              {allowance.addonAllowance > 0
                ? ` + ${allowance.addonAllowance.toLocaleString()} add-on credits`
                : ""}
              . Resets monthly.
            </p>
          </>
        ) : (
          <>
            <p className="text-sm font-semibold text-slate-950">
              AI actions are not included on this plan.
            </p>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Upgrade to Growth or Pro to use AI help for follow-ups, campaigns,
              lesson notes, and insights.
            </p>
          </>
        )}
      </div>

      {activePacks.length > 0 ? (
        <div className="mt-6 rounded-2xl border border-slate-200 bg-white p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-slate-950">
                Active AI packs
              </p>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                Remove a pack when your studio no longer needs the extra monthly
                AI actions. Your plan’s included AI actions stay available.
              </p>
            </div>
          </div>

          <div className="mt-4 space-y-3">
            {activePacks.map((pack) => (
              <div
                key={pack.id}
                className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <p className="text-sm font-semibold text-slate-950">
                    {pack.label ?? "AI credit pack"}
                  </p>
                  <p className="mt-1 text-xs font-medium text-slate-500">
                    +{pack.quantityIncluded.toLocaleString()} AI actions/month
                  </p>
                </div>

                {canManageAddOns && hasManagedSubscription ? (
                  <details className="group rounded-xl border border-red-200 bg-white">
                    <summary className="cursor-pointer list-none rounded-xl px-3 py-2 text-sm font-medium text-red-700 transition hover:bg-red-50 [&::-webkit-details-marker]:hidden">
                      Remove pack
                    </summary>
                    <div className="border-t border-red-100 p-3">
                      <p className="text-xs font-semibold text-slate-950">
                        Remove AI Credit Pack?
                      </p>
                      <p className="mt-1 text-xs leading-5 text-slate-600">
                        This will update your existing DanceFlow subscription.
                        Your card on file is billed by Stripe as part of your
                        monthly subscription. No separate Stripe checkout page
                        will open. Recurring AI credits from this pack will no
                        longer renew after removal.
                      </p>
                      <form
                        action="/api/billing/addons/ai/remove"
                        method="post"
                        className="mt-3"
                      >
                        <input
                          type="hidden"
                          name="entitlement"
                          value={pack.id}
                        />
                        <button
                          type="submit"
                          className="w-full rounded-xl bg-red-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-red-700"
                        >
                          Confirm Remove
                        </button>
                      </form>
                    </div>
                  </details>
                ) : (
                  <button
                    type="button"
                    disabled
                    className="cursor-not-allowed rounded-xl bg-slate-200 px-3 py-2 text-sm font-medium text-slate-500"
                  >
                    Remove pack
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="mt-6 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-sm font-semibold text-slate-950">
              Need more AI help?
            </p>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
              Add extra monthly AI actions for follow-ups, campaign drafts,
              lesson notes, and insights. Packs renew with the studio's
              subscription and can be removed later.
            </p>
          </div>

          <p className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">
            Credits reset monthly
          </p>
        </div>

        <div className="mt-5 space-y-3">
          {(packs ?? []).map((pack) => {
            const canAddPack =
              canManageAddOns &&
              hasManagedSubscription &&
              Boolean(pack.stripePriceId);

            return (
              <div
                key={pack.key}
                className="rounded-2xl border border-slate-200 bg-slate-50 p-4 transition hover:border-violet-200 hover:bg-white"
              >
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <p className="text-base font-semibold text-slate-950">
                        {pack.label}
                      </p>
                      <span className="w-fit rounded-full bg-white px-2.5 py-1 text-xs font-medium text-slate-600 ring-1 ring-slate-200">
                        +{pack.quantityIncluded.toLocaleString()} AI actions/month
                      </span>
                    </div>
                    <p className="mt-2 text-sm leading-6 text-slate-600">
                      {pack.description}
                    </p>
                  </div>

                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center lg:min-w-[260px] lg:justify-end">
                    <p className="text-2xl font-semibold text-slate-950 sm:text-right">
                      {pack.displayPrice}
                    </p>

                    {canAddPack ? (
                      <details className="group rounded-xl border border-[var(--brand-primary)]/20 bg-white sm:min-w-[132px]">
                        <summary className="cursor-pointer list-none rounded-xl bg-[var(--brand-primary)] px-4 py-2 text-center text-sm font-semibold text-white transition hover:opacity-90 [&::-webkit-details-marker]:hidden">
                          Add pack
                        </summary>
                        <div className="border-t border-slate-200 p-3">
                          <p className="text-xs font-semibold text-slate-950">
                            Add AI Credit Pack?
                          </p>
                          <p className="mt-1 text-xs leading-5 text-slate-600">
                            This will add {pack.label} to your current DanceFlow
                            subscription. Your card on file will be billed by Stripe
                            as part of your existing monthly subscription. No
                            separate Stripe checkout page will open.
                          </p>
                          <form
                            action="/api/billing/addons/ai/checkout"
                            method="post"
                            className="mt-3"
                          >
                            <input type="hidden" name="pack" value={pack.key} />
                            <button
                              type="submit"
                              className="w-full rounded-xl bg-slate-900 px-3 py-2 text-sm font-semibold text-white transition hover:bg-slate-800"
                            >
                              Confirm Add Pack
                            </button>
                          </form>
                        </div>
                      </details>
                    ) : (
                      <button
                        type="button"
                        disabled
                        className="cursor-not-allowed rounded-xl bg-slate-200 px-4 py-2 text-sm font-medium text-slate-500 sm:min-w-[132px]"
                      >
                        {hasManagedSubscription
                          ? "Add pack"
                          : "Start plan first"}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <p className="mt-4 text-xs leading-5 text-slate-500">
          Review AI-generated text before sending it to clients or leads.
        </p>
      </div>
    </div>
  );
}

function PlanCard({
  plan,
  selectedAudience,
  isCurrent,
  isRecommended,
  entryMode,
  hasManagedSubscription,
}: {
  plan: BillingPlan;
  selectedAudience: PlanAudience;
  isCurrent: boolean;
  isRecommended: boolean;
  entryMode: string;
  hasManagedSubscription: boolean;
}) {
  const ctaLabel = isCurrent
    ? "Current Plan"
    : hasManagedSubscription
      ? "Change Plan"
      : `Start ${plan.label} Trial`;

  return (
    <div
      className={[
        "rounded-[28px] border bg-white p-6 shadow-sm",
        isRecommended
          ? "border-violet-300 ring-2 ring-violet-100"
          : "border-slate-200",
      ].join(" ")}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
            {plan.audience === "organizer" ? "Organizer Plan" : "Studio Plan"}
          </p>
          <h3 className="mt-2 text-2xl font-semibold text-slate-950">
            {plan.label}
          </h3>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            {plan.description}
          </p>
        </div>

        <div className="flex flex-col items-end gap-2">
          {isCurrent ? (
            <span
              className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${badgeClasses(
                "green",
              )}`}
            >
              Current plan
            </span>
          ) : null}

          {isRecommended ? (
            <span
              className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${badgeClasses(
                "violet",
              )}`}
            >
              Recommended
            </span>
          ) : null}
        </div>
      </div>

      <div className="mt-6">
        <p className="text-3xl font-semibold text-slate-950">
          {formatPlanMoney(plan.amountMonthlyCents)}
          <span className="ml-1 text-base font-medium text-slate-500">
            /month
          </span>
        </p>
        <p className="mt-2 text-sm text-slate-500">
          {plan.trialDays}-day free trial
        </p>
      </div>

      <ul className="mt-6 space-y-2 text-sm text-slate-600">
        {plan.highlights.map((highlight) => (
          <li key={highlight}>• {highlight}</li>
        ))}
      </ul>

      {plan.transparentFeeNote ? (
        <div className="mt-5 rounded-2xl border border-violet-200 bg-violet-50 p-4 text-sm text-violet-800">
          {plan.transparentFeeNote}
        </div>
      ) : null}

      <form action="/api/billing/checkout" method="post" className="mt-6">
        <input type="hidden" name="planCode" value={plan.code} />
        <input type="hidden" name="path" value={selectedAudience} />
        <input type="hidden" name="entry" value={entryMode} />
        <input type="hidden" name="billingInterval" value="month" />

        <button
          type="submit"
          disabled={isCurrent}
          className={[
            "inline-flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-medium transition",
            isCurrent
              ? "cursor-not-allowed border border-slate-300 bg-white text-slate-500"
              : "bg-slate-900 text-white hover:bg-slate-800",
          ].join(" ")}
        >
          <span>{ctaLabel}</span>
          {!isCurrent ? <ArrowRight className="h-4 w-4" /> : null}
        </button>
      </form>
    </div>
  );
}

function OrganizerSuiteAddOnCard({
  activeEntitlement,
  canManageAddOns,
  hasManagedSubscription,
}: {
  activeEntitlement: OrganizerSuiteEntitlement | null;
  canManageAddOns: boolean;
  hasManagedSubscription: boolean;
}) {
  const isActive = activeEntitlement?.status === "active";
  const canChange = canManageAddOns && hasManagedSubscription;

  return (
    <div className="rounded-[32px] border border-violet-200 bg-white p-7 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="rounded-2xl bg-violet-50 p-3 text-violet-700">
          <Sparkles className="h-5 w-5" />
        </div>

        <div className="min-w-0">
          <p className="text-sm font-semibold uppercase tracking-[0.16em] text-violet-700">
            Studio add-on
          </p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-950">
            Organizer Suite
          </h2>
          <p className="mt-2 text-sm leading-7 text-slate-600">
            Keep studio pricing focused while adding ticketing, QR check-in,
            event settlement, event profitability, organizer campaigns, and
            event ARIA when the studio runs ticketed public events.
          </p>
        </div>
      </div>

      <div className="mt-6 rounded-2xl border border-violet-100 bg-violet-50 p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-sm font-semibold text-slate-950">
              {isActive ? "Organizer Suite is active" : "Add Organizer Suite"}
            </p>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              {isActive
                ? "This studio can use DanceFlow ticket checkout, QR tickets, check-in, closeout, and event-growth tools."
                : "Basic event listings stay included. Add Organizer Suite when this studio needs to sell tickets, scan QR check-ins, settle, and grow events."}
            </p>
          </div>

          {isActive && activeEntitlement ? (
            canChange ? (
              <details className="group w-full max-w-sm rounded-xl border border-red-200 bg-white sm:w-auto">
                <summary className="cursor-pointer list-none rounded-xl px-3 py-2 text-sm font-medium text-red-700 transition hover:bg-red-50 [&::-webkit-details-marker]:hidden">
                  Remove add-on
                </summary>
                <div className="border-t border-red-100 p-3">
                  <p className="text-xs font-semibold text-slate-950">
                    Remove Organizer Suite?
                  </p>
                  <p className="mt-1 text-xs leading-5 text-slate-600">
                    This will remove Organizer Suite from your existing
                    DanceFlow subscription. Ticketing, QR check-in, event
                    settlement, organizer campaigns, and event ARIA will no
                    longer be available for this studio. Existing event data
                    will remain saved.
                  </p>
                  <form
                    action="/api/billing/addons/organizer-suite/remove"
                    method="post"
                    className="mt-3"
                  >
                    <input
                      type="hidden"
                      name="entitlement"
                      value={activeEntitlement.id}
                    />
                    <button
                      type="submit"
                      className="w-full rounded-xl bg-red-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-red-700"
                    >
                      Confirm Remove
                    </button>
                  </form>
                </div>
              </details>
            ) : (
              <button
                type="button"
                disabled
                className="cursor-not-allowed rounded-xl bg-slate-200 px-3 py-2 text-sm font-medium text-slate-500"
              >
                Remove add-on
              </button>
            )
          ) : canChange ? (
            <details className="group w-full max-w-sm rounded-xl border border-violet-200 bg-white sm:w-auto">
              <summary className="inline-flex cursor-pointer list-none items-center gap-2 rounded-xl bg-[#5B197A] px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-[#4A1363] [&::-webkit-details-marker]:hidden">
                Add Organizer Suite
                <ArrowRight className="h-4 w-4" />
              </summary>
              <div className="border-t border-violet-100 p-3">
                <p className="text-xs font-semibold text-slate-950">
                  Add Organizer Suite?
                </p>
                <p className="mt-1 text-xs leading-5 text-slate-600">
                  This will add Organizer Suite to your current DanceFlow
                  subscription for $19/month. Your card on file will be billed
                  by Stripe as part of your existing monthly subscription. No
                  separate Stripe checkout page will open.
                </p>
                <p className="mt-2 text-xs leading-5 text-slate-600">
                  Organizer Suite unlocks ticketing, QR check-in, registrations,
                  event settlement, event profitability, organizer campaigns,
                  and event ARIA. Studio add-on ticket platform fees are 3.25%
                  for Starter/Growth and 3.0% for Pro. Cancel anytime from this
                  billing page.
                </p>
                <form
                  action="/api/billing/addons/organizer-suite/checkout"
                  method="post"
                  className="mt-3"
                >
                  <button
                    type="submit"
                    className="w-full rounded-xl bg-slate-900 px-3 py-2 text-sm font-semibold text-white transition hover:bg-slate-800"
                  >
                    Confirm Add-On
                  </button>
                </form>
              </div>
            </details>
          ) : (
            <button
              type="button"
              disabled
              className="inline-flex cursor-not-allowed items-center gap-2 rounded-xl bg-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-500"
            >
              Add Organizer Suite
              <ArrowRight className="h-4 w-4" />
            </button>
          )}
        </div>

        {!hasManagedSubscription ? (
          <p className="mt-3 text-xs leading-5 text-violet-700">
            Start the studio subscription before adding Organizer Suite.
          </p>
        ) : null}
      </div>

      <div className="mt-5 grid gap-3 text-sm text-slate-600 sm:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <p className="font-semibold text-slate-950">
            Included in studio plans
          </p>
          <p className="mt-1 leading-6">
            Basic public event listings for discovery.
          </p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <p className="font-semibold text-slate-950">Unlocked by add-on</p>
          <p className="mt-1 leading-6">
            Ticketing, QR check-in, settlements, campaigns, and event ARIA.
          </p>
        </div>
      </div>
    </div>
  );
}

export default async function BillingSettingsPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const supabase = await createClient();
  const adminSupabase = createAdminClient();
  const stripe = getStripe();
  const resolvedSearchParams = (await searchParams) ?? {};

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const context = await getCurrentStudioContext();
  if (!context?.studioId) {
    redirect("/account");
  }

  const canAccessBilling = canManageBilling(
    context.studioRole,
    context.isPlatformAdmin,
  );

  const studioId = context.studioId;

  if (!canAccessBilling) {
    const workspaceAudience: PlanAudience = getAudienceFromRole(
      context.studioRole,
    );

    return (
      <div className="space-y-8 bg-[linear-gradient(180deg,rgba(255,247,237,0.45)_0%,rgba(255,255,255,0)_22%)] p-1">
        <section className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
          <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                {workspaceAudience === "organizer"
                  ? "DanceFlow Organizer Billing"
                  : "DanceFlow Studio Billing"}
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">
                Billing &amp; Payouts
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85 md:text-base">
                This page is reserved for the account owner so billing, payouts,
                and subscription changes stay protected.
              </p>
            </div>
          </div>

          <div className="border-t border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 px-6 py-5 md:px-8">
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
              <h2 className="text-lg font-semibold text-amber-950">
                You do not have access to billing settings
              </h2>
              <p className="mt-2 text-sm leading-7 text-amber-900">
                Billing and payout controls are limited to the workspace owner.
                Please ask the studio owner or organizer owner to make billing
                changes for this account.
              </p>

              <div className="mt-5 flex flex-wrap gap-3">
                <Link
                  href="/app"
                  className="rounded-xl bg-amber-900 px-4 py-2 text-sm font-medium text-white hover:bg-amber-800"
                >
                  Back to Dashboard
                </Link>

                <Link
                  href="/app/notifications"
                  className="rounded-xl border border-amber-300 bg-white px-4 py-2 text-sm font-medium text-amber-900 hover:bg-amber-100"
                >
                  Open Notifications
                </Link>
              </div>
            </div>
          </div>
        </section>
      </div>
    );
  }

  const { data: studio, error: studioError } = await supabase
    .from("studios")
    .select(
      `
      id,
      name,
      subscription_status,
      stripe_customer_id,
      stripe_subscription_id,
      stripe_connected_account_id,
      stripe_connect_details_submitted,
      stripe_connect_charges_enabled,
      stripe_connect_payouts_enabled,
      stripe_connect_onboarding_complete
    `,
    )
    .eq("id", studioId)
    .single<StudioBillingRow>();

  if (studioError || !studio) {
    redirect("/app");
  }

  const { data: currentSubscriptionRow } = await supabase
    .from("studio_subscriptions")
    .select(
      `
      status,
      subscription_plans (
        code
      )
    `,
    )
    .eq("studio_id", studio.id)
    .maybeSingle<SubscriptionRow>();

  const successParam = parseSingleSearchParam(resolvedSearchParams.success);
  const errorParam = parseSingleSearchParam(resolvedSearchParams.error);
  const entryParam = parseSingleSearchParam(resolvedSearchParams.entry);
  const reasonParam = parseSingleSearchParam(resolvedSearchParams.reason);
  const pathParam = parseSingleSearchParam(resolvedSearchParams.path);
  const recommendedParam = parseSingleSearchParam(
    resolvedSearchParams.recommended,
  );

  const inferredAudience: PlanAudience = getAudienceFromRole(
    context.studioRole,
  );

  const selectedAudience: PlanAudience =
    (isAudience(pathParam) ? pathParam : undefined) ?? inferredAudience;

  const entryMode = getEntryMode(entryParam);

  const currentPlanCode = getCurrentPlanCode(currentSubscriptionRow ?? null);
  const currentPlan =
    currentPlanCode && isPlanCode(currentPlanCode)
      ? getBillingPlan(currentPlanCode)
      : null;

  const recommendedPlanCode =
    (isPlanCode(recommendedParam) ? recommendedParam : undefined) ??
    (selectedAudience === "organizer" ? "organizer" : undefined);

  const recommendedPlan = recommendedPlanCode
    ? getBillingPlan(recommendedPlanCode)
    : null;

  const effectiveSubscriptionStatus =
    currentSubscriptionRow?.status ??
    studio.subscription_status ??
    "not_started";

  const hasManagedSubscription = isManagedSubscriptionStatus(
    effectiveSubscriptionStatus,
  );

  const isTrialCompleteEntry = entryMode === "trial-complete";
  const billingReason = getBillingReason(reasonParam);
  const isAccessPaused = billingReason === "access_paused";
  const showWorkspaceButton = hasManagedSubscription && !isAccessPaused;
  const showPayoutsCard = !isTrialCompleteEntry || hasManagedSubscription;

  const visiblePlans = BILLING_PLANS.filter(
    (plan) => plan.audience === selectedAudience,
  );

  if (studio.stripe_subscription_id) {
    try {
      await syncAiCreditPackEntitlementsForStudio({
        stripe,
        studioId: studio.id,
        stripeSubscriptionId: studio.stripe_subscription_id,
      });
    } catch (error) {
      console.error("Failed to refresh AI credit pack usage", error);
    }
  }

  const aiCreditPacks = getAiCreditPacks();

  const activeAiCreditPacks = await getActiveAiCreditPackEntitlementsForStudio(
    studio.id,
  );

  const { data: activeOrganizerSuiteRows, error: organizerSuiteError } =
    await supabase
      .from("usage_addon_entitlements")
      .select("id, status, stripe_subscription_item_id")
      .eq("studio_id", studio.id)
      .eq("feature_key", "organizer_suite")
      .eq("source", "stripe_subscription_item")
      .eq("status", "active")
      .limit(1);

  if (organizerSuiteError) {
    console.error("Failed to load Organizer Suite add-on", organizerSuiteError);
  }

  const activeOrganizerSuiteEntitlement = (activeOrganizerSuiteRows?.[0] ??
    null) as OrganizerSuiteEntitlement | null;

  const aiUsageAllowance = await getUsageAllowance({
    featureKey: "ai_action",
    quantity: 1,
  });

  const connectReadinessBase: StudioConnectReadiness = {
    connectedAccountId: studio.stripe_connected_account_id ?? null,
    detailsSubmitted: studio.stripe_connect_details_submitted ?? false,
    chargesEnabled: studio.stripe_connect_charges_enabled ?? false,
    payoutsEnabled: studio.stripe_connect_payouts_enabled ?? false,
    onboardingComplete: studio.stripe_connect_onboarding_complete ?? false,
    cardPaymentsEnabled: false,
    transfersEnabled: false,
    currentlyDue: [],
    eventuallyDue: [],
    pendingVerification: [],
    disabledReason: null,
  };

  let connectReadiness = connectReadinessBase;

  if (showPayoutsCard && studio.stripe_connected_account_id) {
    try {
      const connectedAccount = await stripe.accounts.retrieve(
        studio.stripe_connected_account_id,
      );

      connectReadiness = {
        connectedAccountId: studio.stripe_connected_account_id,
        detailsSubmitted:
          connectedAccount.details_submitted ??
          studio.stripe_connect_details_submitted ??
          false,
        chargesEnabled:
          connectedAccount.charges_enabled ??
          studio.stripe_connect_charges_enabled ??
          false,
        payoutsEnabled:
          connectedAccount.payouts_enabled ??
          studio.stripe_connect_payouts_enabled ??
          false,
        onboardingComplete:
          connectedAccount.details_submitted ??
          studio.stripe_connect_onboarding_complete ??
          false,
        cardPaymentsEnabled:
          connectedAccount.capabilities?.card_payments === "active",
        transfersEnabled: connectedAccount.capabilities?.transfers === "active",
        currentlyDue: connectedAccount.requirements?.currently_due ?? [],
        eventuallyDue: connectedAccount.requirements?.eventually_due ?? [],
        pendingVerification:
          connectedAccount.requirements?.pending_verification ?? [],
        disabledReason: connectedAccount.requirements?.disabled_reason ?? null,
      };
    } catch (error) {
      console.error("Failed to retrieve connected account readiness", error);
    }
  }

  const { data: terminalLocationsRows, error: terminalLocationsError } =
    await adminSupabase
      .from("stripe_terminal_locations")
      .select(
        "id, stripe_location_id, display_name, city, state, postal_code, active, created_at",
      )
      .eq("studio_id", studio.id)
      .eq("active", true)
      .order("created_at", { ascending: true });

  if (terminalLocationsError) {
    console.error("Failed to load Terminal locations", terminalLocationsError);
  }

  const { data: terminalReaderRows, error: terminalReadersError } =
    await adminSupabase
      .from("stripe_terminal_readers")
      .select(
        "id, terminal_location_id, stripe_reader_id, label, device_type, status, ip_address, last_seen_at, active, created_at",
      )
      .eq("studio_id", studio.id)
      .eq("active", true)
      .order("created_at", { ascending: true });

  if (terminalReadersError) {
    console.error("Failed to load Terminal readers", terminalReadersError);
  }

  const terminalLocations = (terminalLocationsRows ??
    []) as TerminalLocationRow[];
  const terminalReaders = (terminalReaderRows ?? []) as TerminalReaderRow[];

  const connectStatus = getConnectStatus(connectReadiness);
  const successMessage = getSuccessMessage(successParam, selectedAudience);
  const errorMessage = getErrorMessage(errorParam);

  return (
    <main className="min-h-screen bg-[linear-gradient(180deg,rgba(255,247,237,0.45)_0%,rgba(255,255,255,0)_22%)]">
      <section className="mx-auto max-w-7xl px-6 pt-8">
        <div className="overflow-hidden rounded-[32px] border border-[var(--brand-border)] bg-white shadow-sm">
          <div className="bg-[linear-gradient(135deg,var(--brand-primary)_0%,#4b2e83_100%)] px-6 py-8 text-white md:px-8">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
              <div className="max-w-3xl">
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
                  DanceFlow
                </p>

                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <span
                    className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${badgeClasses(
                      getWorkspaceTone(selectedAudience),
                    )}`}
                  >
                    {getWorkspaceTitle(selectedAudience)}
                  </span>

                  <span
                    className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${badgeClasses(
                      getSubscriptionTone(effectiveSubscriptionStatus),
                    )}`}
                  >
                    {getSubscriptionLabel(effectiveSubscriptionStatus)}
                  </span>
                </div>

                <h1 className="mt-4 text-3xl font-semibold tracking-tight md:text-4xl">
                  Billing &amp; Payouts
                </h1>

                <p className="mt-3 max-w-2xl text-sm leading-7 text-white/85 md:text-base">
                  {isTrialCompleteEntry && !hasManagedSubscription
                    ? `Start your ${
                        selectedAudience === "organizer"
                          ? "organizer"
                          : "studio"
                      } subscription and begin your free trial.`
                    : `Manage your subscription, connect Stripe, and keep this ${
                        selectedAudience === "organizer"
                          ? "organizer"
                          : "studio"
                      } workspace ready to collect payments and receive payouts.`}
                </p>
              </div>

              <div className="flex flex-wrap gap-3">
                {hasManagedSubscription && studio.stripe_customer_id ? (
                  <form action="/api/billing/portal" method="post">
                    <button
                      type="submit"
                      className="rounded-xl border border-white/25 bg-white/10 px-4 py-2.5 text-sm font-medium text-white backdrop-blur hover:bg-white/20"
                    >
                      Open Billing Portal
                    </button>
                  </form>
                ) : null}

                {showWorkspaceButton ? (
                  <Link
                    href={getPostTrialDashboardPath(selectedAudience)}
                    className="rounded-xl bg-white px-4 py-2.5 text-sm font-medium text-[var(--brand-primary)] hover:bg-white/90"
                  >
                    Go to Workspace
                  </Link>
                ) : null}
              </div>
            </div>
          </div>

          <div className="border-t border-[var(--brand-border)] bg-[var(--brand-primary-soft)]/35 px-6 py-5 md:px-8">
            <div className="grid gap-4 md:grid-cols-3">
              <InfoCard
                label="Workspace"
                value={studio.name ?? "Workspace"}
                icon={Sparkles}
              />
              <InfoCard
                label="Subscription"
                value={getSubscriptionLabel(effectiveSubscriptionStatus)}
                icon={CreditCard}
              />
              <InfoCard
                label={showPayoutsCard ? "Payout setup" : "Next step"}
                value={
                  showPayoutsCard ? connectStatus.label : "Complete billing"
                }
                icon={showPayoutsCard ? Wallet : ArrowRight}
              />
            </div>
          </div>
        </div>

        {isTrialCompleteEntry && !hasManagedSubscription ? (
          <div
            className={`mt-6 rounded-2xl border p-4 text-sm ${
              selectedAudience === "organizer"
                ? "border-violet-200 bg-violet-50 text-violet-800"
                : "border-sky-200 bg-sky-50 text-sky-800"
            }`}
          >
            {selectedAudience === "organizer"
              ? "Complete billing first to begin your organizer trial. Payout setup comes after your subscription is started."
              : "Complete billing first to begin your studio trial. Payout setup comes after your subscription is started."}
          </div>
        ) : entryMode === "trial-complete" ? (
          <div
            className={`mt-6 rounded-2xl border p-4 text-sm ${
              selectedAudience === "organizer"
                ? "border-violet-200 bg-violet-50 text-violet-800"
                : "border-sky-200 bg-sky-50 text-sky-800"
            }`}
          >
            {selectedAudience === "organizer"
              ? "Your organizer trial is active. You can manage billing, continue into the workspace, and complete payouts when needed."
              : "Your studio trial is active. You can manage billing, continue into the workspace, and complete payouts when needed."}
          </div>
        ) : null}

        {isAccessPaused ? (
          <div className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
            <p className="font-semibold">Workspace access paused</p>
            <p className="mt-1">
              Billing must be resolved before access to this workspace is
              restored. Update your subscription or payment method below to
              regain access.
            </p>
          </div>
        ) : null}

        {successMessage ? (
          <div
            className={`mt-6 rounded-2xl border p-4 text-sm ${
              successMessage.tone === "green"
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : successMessage.tone === "violet"
                  ? "border-violet-200 bg-violet-50 text-violet-800"
                  : "border-sky-200 bg-sky-50 text-sky-800"
            }`}
          >
            <p className="font-semibold">{successMessage.title}</p>
            <p className="mt-1">{successMessage.body}</p>
          </div>
        ) : null}

        {errorMessage ? (
          <div className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
            <p className="font-semibold">Billing issue</p>
            <p className="mt-1">{errorMessage}</p>
          </div>
        ) : null}
      </section>

      <section className="mx-auto max-w-7xl px-6 py-10">
        <div className="space-y-8">
          {showPayoutsCard ? (
            <div className="space-y-5">
              <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
                <div>
                  <p className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
                    Payment collection
                  </p>
                  <h2 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
                    Collect payments and manage readers
                  </h2>
                  <p className="mt-2 max-w-3xl text-sm leading-7 text-slate-600">
                    Start here for Stripe payout readiness, DanceFlow-initiated
                    card reader payments, and Quick Charge setup.
                  </p>
                </div>

                <Link
                  href="/app/payments/quick-charge"
                  className="inline-flex w-fit items-center gap-2 rounded-xl bg-slate-900 px-4 py-3 text-sm font-medium text-white hover:bg-slate-800"
                >
                  <span>Open Quick Charge</span>
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </div>

              <div className="grid gap-8 xl:grid-cols-[0.9fr_1.1fr]">
                <div className="rounded-[32px] border border-slate-200 bg-white p-7 shadow-sm">
                  <div className="flex items-start gap-3">
                    <div className="rounded-2xl bg-[var(--brand-primary-soft)] p-3 text-[var(--brand-primary)]">
                      <ShieldCheck className="h-5 w-5" />
                    </div>

                    <div className="min-w-0">
                      <p className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
                        Stripe payouts
                      </p>
                      <h3 className="mt-2 text-2xl font-semibold text-slate-950">
                        Connect payout details
                      </h3>
                      <p className="mt-2 text-sm leading-7 text-slate-600">
                        {connectStatus.description}
                      </p>
                    </div>
                  </div>

                  <div className="mt-6 flex flex-wrap items-center gap-3">
                    <span
                      className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${badgeClasses(
                        connectStatus.tone,
                      )}`}
                    >
                      {connectStatus.label}
                    </span>

                    <a
                      href="/api/stripe/connect/onboarding"
                      className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800"
                    >
                      <span>{connectStatus.buttonLabel}</span>
                      <ArrowRight className="h-4 w-4" />
                    </a>
                  </div>

                  <div className="mt-5 rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm leading-6 text-sky-900">
                    <p className="font-semibold">
                      DanceFlow-started card payments need a physical Stripe
                      Terminal reader.
                    </p>
                    <p className="mt-1">
                      Use a supported smart reader such as Stripe Reader
                      S700/S710 or BBPOS WisePOS E. Stripe Dashboard Tap to Pay
                      is a separate fallback and does not automatically attach
                      payments to DanceFlow records.
                    </p>
                  </div>

                  {connectReadiness.disabledReason ? (
                    <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
                      Stripe disabled reason:{" "}
                      {formatStripeRequirementLabel(
                        connectReadiness.disabledReason,
                      )}
                    </div>
                  ) : null}

                  {connectReadiness.currentlyDue.length > 0 ? (
                    <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                      <p className="text-sm font-semibold text-slate-900">
                        Currently due
                      </p>
                      <ul className="mt-2 space-y-2 text-sm text-slate-600">
                        {connectReadiness.currentlyDue
                          .slice(0, 8)
                          .map((item) => (
                            <li key={item}>
                              • {formatStripeRequirementLabel(item)}
                            </li>
                          ))}
                      </ul>
                    </div>
                  ) : null}

                  {connectReadiness.pendingVerification.length > 0 ? (
                    <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                      <p className="text-sm font-semibold text-slate-900">
                        Pending verification
                      </p>
                      <ul className="mt-2 space-y-2 text-sm text-slate-600">
                        {connectReadiness.pendingVerification
                          .slice(0, 8)
                          .map((item) => (
                            <li key={item}>
                              • {formatStripeRequirementLabel(item)}
                            </li>
                          ))}
                      </ul>
                    </div>
                  ) : null}
                </div>

                <TerminalReadersCard
                  connectReadiness={connectReadiness}
                  locations={terminalLocations}
                  readers={terminalReaders}
                  canManage={canAccessBilling}
                />
              </div>
            </div>
          ) : null}

          <div className="space-y-5">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
                Add-ons and usage
              </p>
              <h2 className="mt-2 text-2xl font-semibold text-slate-950">
                Optional growth tools
              </h2>
              <p className="mt-2 max-w-3xl text-sm leading-7 text-slate-600">
                Manage add-on services and AI capacity after payment collection
                setup.
              </p>
            </div>

            <div
              className={
                selectedAudience === "studio"
                  ? "grid gap-6 lg:grid-cols-2"
                  : "grid gap-6"
              }
            >
              {selectedAudience === "studio" ? (
                <OrganizerSuiteAddOnCard
                  activeEntitlement={activeOrganizerSuiteEntitlement}
                  canManageAddOns={canAccessBilling}
                  hasManagedSubscription={hasManagedSubscription}
                />
              ) : null}

              <UsageAllowanceCard
                allowance={aiUsageAllowance}
                packs={aiCreditPacks}
                activePacks={activeAiCreditPacks}
                canManageAddOns={canAccessBilling}
                hasManagedSubscription={hasManagedSubscription}
              />
            </div>
          </div>

          <div className="rounded-[32px] border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="min-w-0">
                <p className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
                  Subscription
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <h2 className="text-2xl font-semibold text-slate-950">
                    {currentPlan?.label ?? "Choose a plan"}
                  </h2>
                  <span
                    className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${badgeClasses(
                      getSubscriptionTone(effectiveSubscriptionStatus),
                    )}`}
                  >
                    {getSubscriptionLabel(effectiveSubscriptionStatus)}
                  </span>
                </div>
                <p className="mt-2 max-w-3xl text-sm leading-7 text-slate-600">
                  Subscription changes are usually occasional. Use this compact
                  section when you need to start billing, change plans, or
                  update payment details.
                </p>
              </div>

              <div className="flex flex-wrap gap-3">
                {hasManagedSubscription && studio.stripe_customer_id ? (
                  <form action="/api/billing/portal" method="post">
                    <button
                      type="submit"
                      className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800"
                    >
                      Open Billing Portal
                    </button>
                  </form>
                ) : null}

                {showWorkspaceButton ? (
                  <Link
                    href={getPostTrialDashboardPath(selectedAudience)}
                    className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    Go to Workspace
                  </Link>
                ) : null}
              </div>
            </div>

            <details className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <summary className="cursor-pointer text-sm font-semibold text-slate-900">
                View or change available{" "}
                {selectedAudience === "organizer" ? "organizer" : "studio"}{" "}
                plans
              </summary>

              <div className="mt-5 grid gap-6 lg:grid-cols-2">
                {visiblePlans.map((plan) => (
                  <PlanCard
                    key={plan.code}
                    plan={plan}
                    selectedAudience={selectedAudience}
                    isCurrent={currentPlan?.code === plan.code}
                    isRecommended={recommendedPlan?.code === plan.code}
                    entryMode={entryMode}
                    hasManagedSubscription={hasManagedSubscription}
                  />
                ))}
              </div>
            </details>
          </div>

          <div className="rounded-[32px] border border-slate-200 bg-white p-7 shadow-sm">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.16em] text-slate-500">
                  Next step
                </p>
                <h2 className="mt-2 text-2xl font-semibold text-slate-950">
                  Continue into the correct workspace
                </h2>
                <p className="mt-2 text-sm leading-7 text-slate-600">
                  {selectedAudience === "organizer"
                    ? "Continue into event operations and complete payout setup when needed."
                    : "Continue into the studio workspace and finish payment setup as needed."}
                </p>
              </div>

              <Link
                href={selectedAudience === "organizer" ? "/app/events" : "/app"}
                className="inline-flex w-fit items-center gap-2 rounded-xl bg-slate-900 px-4 py-3 text-sm font-medium text-white hover:bg-slate-800"
              >
                <span>
                  {selectedAudience === "organizer"
                    ? "Go to Organizer Workspace"
                    : "Go to Studio Workspace"}
                </span>
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
