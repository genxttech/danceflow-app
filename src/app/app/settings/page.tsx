import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import SettingsForm from "./SettingsForm";
import { updateStudioMarketingFooterAction } from "./actions";
import { canManageSettings } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { studioHasFeature } from "@/lib/billing/access";

type StudioRow = {
  id: string;
  name: string;
  email: string | null;
  address_line_1: string | null;
  address_line_2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  latitude: number | null;
  longitude: number | null;
  public_name: string | null;
  public_short_description: string | null;
  public_about: string | null;
  public_phone: string | null;
  public_email: string | null;
  public_website_url: string | null;
  public_lead_enabled: boolean;
  public_lead_headline: string | null;
  public_lead_description: string | null;
  public_logo_url: string | null;
  public_hero_image_url: string | null;
  public_primary_color: string | null;
  public_lead_cta_text: string | null;
};

type StudioSettingsRow = {
  lumi_enabled: boolean | null;
  timezone: string | null;
  currency: string | null;
  cancellation_window_hours: number | null;
  booking_lead_time_hours: number | null;
  no_show_deducts_lesson: boolean | null;
  allow_negative_balance: boolean | null;
  block_depleted_package_booking: boolean | null;
  warn_low_package_balance: boolean | null;
  public_intro_booking_enabled: boolean | null;
  portal_self_scheduling_enabled: boolean | null;
  portal_self_scheduling_mode: string | null;
  portal_self_scheduling_reschedule_mode: string | null;
  portal_self_scheduling_cancellation_mode: string | null;
  portal_self_scheduling_window_days: number | null;
  portal_self_scheduling_min_notice_hours: number | null;
  portal_self_scheduling_cancellation_cutoff_hours: number | null;
  portal_self_scheduling_slot_interval_minutes: number | null;
  portal_self_scheduling_default_duration_minutes: number | null;
  portal_self_scheduling_require_active_credit: boolean | null;
  portal_self_scheduling_allow_unlinked_requests: boolean | null;
  portal_self_scheduling_auto_assign_room: boolean | null;
  portal_self_scheduling_requires_payment_method: boolean | null;
  intro_lesson_duration_minutes: number | null;
  intro_booking_window_days: number | null;
  intro_default_instructor_id: string | null;
  intro_default_room_id: string | null;
  booking_request_allowed_weekdays: number[] | null;
  booking_request_start_time: string | null;
  booking_request_end_time: string | null;
  public_intro_bookable_instructor_ids: string[] | null;
  portal_bookable_instructor_ids: string[] | null;
  portal_bookable_lesson_types: string[] | null;
};

type StudioNotificationSettingsRow = {
  public_intro_booking_enabled: boolean;
  follow_up_overdue_enabled: boolean;
  package_low_balance_enabled: boolean;
  package_depleted_enabled: boolean;
  floor_rental_upcoming_enabled: boolean;
};

type InstructorOption = {
  id: string;
  first_name: string;
  last_name: string;
};

type RoomOption = {
  id: string;
  name: string;
};

type BillingSummary = {
  hasCustomer: boolean;
  planName: string;
  planCode: string;
  status: string;
  billingInterval: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
};

function formatPlanName(code: string | null | undefined) {
  if (!code) return "No plan";
  if (code === "starter") return "Starter";
  if (code === "growth") return "Growth";
  if (code === "pro") return "Pro";
  return code.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

export default async function SettingsPage() {
  const supabase = await createClient();
  const context = await getCurrentStudioContext();

  if (!canManageSettings(context.studioRole ?? "")) {
    redirect("/app");
  }

  const studioId = context.studioId;
  const [lumiAvailable, waveAvailable] = await Promise.all([
    studioHasFeature("ai_assistant"),
    studioHasFeature("wave_accounting"),
  ]);

  const [
    { data: studio, error: studioError },
    { data: settings, error: settingsError },
    { data: notificationSettings, error: notificationSettingsError },
    { data: instructors, error: instructorsError },
    { data: rooms, error: roomsError },
    { data: billingCustomer, error: billingCustomerError },
    { data: studioSubscription, error: studioSubscriptionError },
  ] = await Promise.all([
    supabase
      .from("studios")
      .select(`
        id,
        name,
        email,
        address_line_1,
        address_line_2,
        city,
        state,
        postal_code,
        country,
        latitude,
        longitude,
        public_name,
        public_short_description,
        public_about,
        public_phone,
        public_email,
        public_website_url,
        public_lead_enabled,
        public_lead_headline,
        public_lead_description,
        public_logo_url,
        public_hero_image_url,
        public_primary_color,
        public_lead_cta_text
      `)
      .eq("id", studioId)
      .single(),

    supabase
      .from("studio_settings")
      .select(`
        lumi_enabled,
        timezone,
        currency,
        cancellation_window_hours,
        booking_lead_time_hours,
        no_show_deducts_lesson,
        allow_negative_balance,
        block_depleted_package_booking,
        warn_low_package_balance,
        public_intro_booking_enabled,
        portal_self_scheduling_enabled,
        portal_self_scheduling_mode,
        portal_self_scheduling_reschedule_mode,
        portal_self_scheduling_cancellation_mode,
        portal_self_scheduling_window_days,
        portal_self_scheduling_min_notice_hours,
        portal_self_scheduling_cancellation_cutoff_hours,
        portal_self_scheduling_slot_interval_minutes,
        portal_self_scheduling_default_duration_minutes,
        portal_self_scheduling_require_active_credit,
        portal_self_scheduling_allow_unlinked_requests,
        portal_self_scheduling_auto_assign_room,
        portal_self_scheduling_requires_payment_method,
        intro_lesson_duration_minutes,
        intro_booking_window_days,
        intro_default_instructor_id,
        intro_default_room_id,
        booking_request_allowed_weekdays,
        booking_request_start_time,
        booking_request_end_time,
        public_intro_bookable_instructor_ids,
        portal_bookable_instructor_ids,
        portal_bookable_lesson_types
      `)
      .eq("studio_id", studioId)
      .single(),

    supabase
      .from("studio_notification_settings")
      .select(`
        public_intro_booking_enabled,
        follow_up_overdue_enabled,
        package_low_balance_enabled,
        package_depleted_enabled,
        floor_rental_upcoming_enabled
      `)
      .eq("studio_id", studioId)
      .maybeSingle(),

    supabase
      .from("instructors")
      .select("id, first_name, last_name")
      .eq("studio_id", studioId)
      .eq("active", true)
      .order("first_name", { ascending: true }),

    supabase
      .from("rooms")
      .select("id, name")
      .eq("studio_id", studioId)
      .eq("active", true)
      .order("name", { ascending: true }),

    supabase
      .from("studio_billing_customers")
      .select("id, stripe_customer_id, billing_email, contact_name")
      .eq("studio_id", studioId)
      .maybeSingle(),

    supabase
      .from("studio_subscriptions")
      .select(`
        id,
        status,
        billing_interval,
        current_period_end,
        cancel_at_period_end,
        subscription_plans (
          code,
          name
        )
      `)
      .eq("studio_id", studioId)
      .maybeSingle(),
  ]);

  if (studioError || !studio) {
    throw new Error(`Failed to load studio: ${studioError?.message ?? "Studio not found"}`);
  }

  if (settingsError || !settings) {
    throw new Error(
      `Failed to load studio settings: ${settingsError?.message ?? "Settings not found"}`
    );
  }

  if (notificationSettingsError) {
    throw new Error(
      `Failed to load notification settings: ${notificationSettingsError.message}`
    );
  }

  if (instructorsError) {
    throw new Error(`Failed to load instructors: ${instructorsError.message}`);
  }

  if (roomsError) {
    throw new Error(`Failed to load rooms: ${roomsError.message}`);
  }

  if (billingCustomerError) {
    throw new Error(`Failed to load billing customer: ${billingCustomerError.message}`);
  }

  if (studioSubscriptionError) {
    throw new Error(`Failed to load studio subscription: ${studioSubscriptionError.message}`);
  }

  const typedNotificationSettings: StudioNotificationSettingsRow = notificationSettings ?? {
    public_intro_booking_enabled: true,
    follow_up_overdue_enabled: true,
    package_low_balance_enabled: true,
    package_depleted_enabled: true,
    floor_rental_upcoming_enabled: true,
  };

  const planValue = Array.isArray(studioSubscription?.subscription_plans)
    ? studioSubscription.subscription_plans[0]
    : studioSubscription?.subscription_plans;

  const billingSummary: BillingSummary = {
    hasCustomer: Boolean(billingCustomer),
    planName: planValue?.name ?? formatPlanName(planValue?.code),
    planCode: planValue?.code ?? "",
    status: studioSubscription?.status ?? "inactive",
    billingInterval: studioSubscription?.billing_interval ?? "month",
    currentPeriodEnd: studioSubscription?.current_period_end ?? null,
    cancelAtPeriodEnd: Boolean(studioSubscription?.cancel_at_period_end),
  };

  return (
    <div className="space-y-8">
      <section className="overflow-hidden rounded-3xl border border-white/15 bg-[linear-gradient(135deg,#2D0B45_0%,#4C1D95_55%,#7C2D92_100%)] p-6 text-white shadow-sm md:p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
          DanceFlow Settings
        </p>
        <div className="mt-3 max-w-3xl">
          <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">
            Set up how your studio runs
          </h1>
          <p className="mt-3 text-sm leading-6 text-white/80 md:text-base">
            Start with everyday studio operations. Business connections, public
            presence, and occasional setup tools are grouped below when you need them.
          </p>
        </div>
      </section>

      <section aria-labelledby="studio-operations-heading">
        <div className="mb-4">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-700">
            Start here
          </p>
          <h2
            id="studio-operations-heading"
            className="mt-1 text-2xl font-semibold tracking-tight text-slate-950"
          >
            Studio operations
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            Manage the settings that affect daily scheduling, student access,
            policies, reminders, and studio defaults.
          </p>
        </div>

        <SettingsForm
          studio={studio as StudioRow}
          settings={settings as StudioSettingsRow}
          notificationSettings={typedNotificationSettings}
          instructors={(instructors ?? []) as InstructorOption[]}
          role={context.studioRole ?? ""}
          billingSummary={billingSummary}
          lumiAvailable={lumiAvailable}
        />
      </section>

      <section
        aria-labelledby="business-setup-heading"
        className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm md:p-6"
      >
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
            When you need it
          </p>
          <h2
            id="business-setup-heading"
            className="mt-1 text-2xl font-semibold tracking-tight text-slate-950"
          >
            Business setup
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            Connect outside services, manage the DanceFlow plan, prepare accountant
            delivery, or bring existing data into the studio.
          </p>
        </div>

        <div className="mt-5 divide-y divide-slate-200 rounded-2xl border border-slate-200">
          <Link
            href="/app/settings/accountant"
            className="flex items-center justify-between gap-4 px-4 py-4 transition hover:bg-slate-50"
          >
            <span>
              <span className="block font-semibold text-slate-950">
                Accountant and report delivery
              </span>
              <span className="mt-1 block text-sm text-slate-600">
                Choose who receives reports, what they receive, and when.
              </span>
            </span>
            <span aria-hidden="true" className="text-xl text-slate-400">
              →
            </span>
          </Link>

          <Link
            href="/app/settings/integrations"
            className="flex items-center justify-between gap-4 px-4 py-4 transition hover:bg-slate-50"
          >
            <span>
              <span className="block font-semibold text-slate-950">
                Integrations
              </span>
              <span className="mt-1 block text-sm text-slate-600">
                {waveAvailable
                  ? "Manage Wave, Stripe, calendar, and other connected services."
                  : "Manage Stripe and other connected services. Wave is available on Pro."}
              </span>
            </span>
            <span aria-hidden="true" className="text-xl text-slate-400">
              →
            </span>
          </Link>

          <Link
            href="/app/settings/billing"
            className="flex items-center justify-between gap-4 px-4 py-4 transition hover:bg-slate-50"
          >
            <span>
              <span className="block font-semibold text-slate-950">
                DanceFlow plan and billing
              </span>
              <span className="mt-1 block text-sm text-slate-600">
                Review the current plan, subscription status, and payment setup.
              </span>
            </span>
            <span aria-hidden="true" className="text-xl text-slate-400">
              →
            </span>
          </Link>

          <Link
            href="/app/settings/import"
            className="flex items-center justify-between gap-4 px-4 py-4 transition hover:bg-slate-50"
          >
            <span>
              <span className="block font-semibold text-slate-950">
                Import existing data
              </span>
              <span className="mt-1 block text-sm text-slate-600">
                Bring clients into DanceFlow from a reviewed CSV file.
              </span>
            </span>
            <span aria-hidden="true" className="text-xl text-slate-400">
              →
            </span>
          </Link>
        </div>
      </section>

      <section
        aria-labelledby="public-presence-heading"
        className="rounded-3xl border border-fuchsia-200 bg-white p-5 shadow-sm md:p-6"
      >
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-fuchsia-700">
              Public presence
            </p>
            <h2
              id="public-presence-heading"
              className="mt-1 text-2xl font-semibold tracking-tight text-slate-950"
            >
              Help dancers find and contact the studio
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
              Manage the public profile, branding, discovery, inquiries, and intro
              lesson requests in one place.
            </p>
          </div>

          <Link
            href="/app/settings/public-profile"
            className="inline-flex shrink-0 items-center justify-center rounded-xl bg-fuchsia-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-fuchsia-800"
          >
            Open public presence
          </Link>
        </div>
      </section>

      <details className="group rounded-3xl border border-slate-200 bg-white shadow-sm">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-4 p-5 md:p-6">
          <span>
            <span className="block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              Occasional setup
            </span>
            <span className="mt-1 block text-xl font-semibold text-slate-950">
              Marketing email footer
            </span>
            <span className="mt-1 block text-sm text-slate-600">
              Update the studio reply-to email and mailing address used in campaigns.
            </span>
          </span>
          <span
            aria-hidden="true"
            className="text-2xl text-slate-400 transition group-open:rotate-45"
          >
            +
          </span>
        </summary>

        <form
          action={updateStudioMarketingFooterAction}
          className="border-t border-slate-200 p-5 md:p-6"
        >
          <div className="grid gap-4 md:grid-cols-2">
            <div className="md:col-span-2">
              <label
                htmlFor="marketingReplyToEmail"
                className="text-sm font-medium text-slate-900"
              >
                Reply-to email
              </label>
              <input
                id="marketingReplyToEmail"
                name="marketingReplyToEmail"
                type="email"
                defaultValue={(studio as StudioRow).email ?? ""}
                placeholder="studio@example.com"
                className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
              />
              <p className="mt-1 text-xs text-slate-500">
                Campaign replies go to this studio email.
              </p>
            </div>

            <div className="md:col-span-2">
              <label
                htmlFor="marketingAddressLine1"
                className="text-sm font-medium text-slate-900"
              >
                Mailing address line 1
              </label>
              <input
                id="marketingAddressLine1"
                name="marketingAddressLine1"
                defaultValue={(studio as StudioRow).address_line_1 ?? ""}
                placeholder="Street address or PO Box"
                className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
              />
            </div>

            <div className="md:col-span-2">
              <label
                htmlFor="marketingAddressLine2"
                className="text-sm font-medium text-slate-900"
              >
                Mailing address line 2
              </label>
              <input
                id="marketingAddressLine2"
                name="marketingAddressLine2"
                defaultValue={(studio as StudioRow).address_line_2 ?? ""}
                placeholder="Suite, unit, floor, or additional address detail"
                className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label
                htmlFor="marketingCity"
                className="text-sm font-medium text-slate-900"
              >
                City
              </label>
              <input
                id="marketingCity"
                name="marketingCity"
                defaultValue={(studio as StudioRow).city ?? ""}
                className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label
                htmlFor="marketingState"
                className="text-sm font-medium text-slate-900"
              >
                State / region
              </label>
              <input
                id="marketingState"
                name="marketingState"
                defaultValue={(studio as StudioRow).state ?? ""}
                className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label
                htmlFor="marketingPostalCode"
                className="text-sm font-medium text-slate-900"
              >
                Postal code
              </label>
              <input
                id="marketingPostalCode"
                name="marketingPostalCode"
                defaultValue={(studio as StudioRow).postal_code ?? ""}
                className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label
                htmlFor="marketingCountry"
                className="text-sm font-medium text-slate-900"
              >
                Country
              </label>
              <input
                id="marketingCountry"
                name="marketingCountry"
                defaultValue={(studio as StudioRow).country ?? "United States"}
                className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
              />
            </div>
          </div>

          <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="max-w-3xl text-xs leading-5 text-slate-500">
              This address appears in marketing email footers. DanceFlow continues
              to suppress unsubscribed contacts.
            </p>
            <button
              type="submit"
              className="inline-flex shrink-0 items-center justify-center rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800"
            >
              Save footer
            </button>
          </div>
        </form>
      </details>
    </div>
  );
}
