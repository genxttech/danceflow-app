import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import SettingsForm from "./SettingsForm";
import { updateStudioMarketingFooterAction } from "./actions";
import { canManageSettings } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";

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
  timezone: string | null;
  currency: string | null;
  cancellation_window_hours: number | null;
  booking_lead_time_hours: number | null;
  no_show_deducts_lesson: boolean | null;
  allow_negative_balance: boolean | null;
  block_depleted_package_booking: boolean | null;
  warn_low_package_balance: boolean | null;
  public_intro_booking_enabled: boolean | null;
  intro_lesson_duration_minutes: number | null;
  intro_booking_window_days: number | null;
  intro_default_instructor_id: string | null;
  intro_default_room_id: string | null;
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
        timezone,
        currency,
        cancellation_window_hours,
        booking_lead_time_hours,
        no_show_deducts_lesson,
        allow_negative_balance,
        block_depleted_package_booking,
        warn_low_package_balance,
        public_intro_booking_enabled,
        intro_lesson_duration_minutes,
        intro_booking_window_days,
        intro_default_instructor_id,
        intro_default_room_id
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
    <div className="space-y-6">
      <div className="overflow-hidden rounded-3xl border bg-white shadow-sm">
        <div className="bg-gradient-to-r from-violet-700 via-fuchsia-600 to-pink-500 p-6 text-white">
          <p className="text-sm font-semibold uppercase tracking-[0.25em] text-white/80">
            DanceFlow Studio Admin
          </p>
          <div className="mt-3 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div className="max-w-3xl">
              <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">
                Studio setup and controls
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-white/90 md:text-base">
                Manage the settings that keep your studio running smoothly: studio policies, public branding, client booking rules, notifications, billing access, and data import.
              </p>
            </div>

            <div className="flex flex-wrap gap-3">
              <Link
                href="/app/settings/import"
                className="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-violet-700 shadow-sm hover:bg-violet-50"
              >
                Import Data
              </Link>

              <Link
                href="/app/settings/billing"
                className="rounded-xl border border-white/40 bg-white/10 px-4 py-2 text-sm font-semibold text-white hover:bg-white/20"
              >
                Billing Settings
              </Link>
            </div>
          </div>
        </div>

        <div className="grid gap-4 p-5 md:grid-cols-3">
          <div className="rounded-2xl border bg-slate-50 p-4">
            <p className="text-sm font-semibold text-slate-900">Studio profile</p>
            <p className="mt-1 text-sm text-slate-600">Keep public branding, booking options, and contact details current.</p>
          </div>
          <div className="rounded-2xl border bg-slate-50 p-4">
            <p className="text-sm font-semibold text-slate-900">Policies and reminders</p>
            <p className="mt-1 text-sm text-slate-600">Control cancellation windows, booking lead time, low-balance warnings, and notifications.</p>
          </div>
          <div className="rounded-2xl border bg-slate-50 p-4">
            <p className="text-sm font-semibold text-slate-900">Launch tools</p>
            <p className="mt-1 text-sm text-slate-600">Use import and billing setup to prepare the studio before inviting clients.</p>
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Link
          href="/app/settings/import"
          className="rounded-2xl border bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-violet-200 hover:shadow-md"
        >
          <p className="text-sm font-semibold uppercase tracking-wide text-violet-600">Data Import</p>
          <h2 className="mt-2 text-xl font-semibold text-slate-900">
            Bring existing clients into DanceFlow
          </h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Upload a CSV, review row-level errors, then execute the import when the file is ready. Uploading alone does not add clients.
          </p>
        </Link>

        <Link
          href="/app/settings/billing"
          className="rounded-2xl border bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-violet-200 hover:shadow-md"
        >
          <p className="text-sm font-medium text-slate-500">Billing</p>
          <h2 className="mt-2 text-xl font-semibold text-slate-900">
            Studio subscription and plan
          </h2>
          <p className="mt-2 text-sm text-slate-600">
            Review billing status, subscription details, and payment setup.
          </p>
        </Link>
      </div>

      <form
        action={updateStudioMarketingFooterAction}
        className="rounded-3xl border bg-white p-5 shadow-sm"
      >
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-wide text-violet-600">
              Marketing Email Footer
            </p>
            <h2 className="mt-2 text-xl font-semibold text-slate-900">
              Studio mailing address for campaigns
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
              DanceFlow will use this business mailing address and reply-to email in studio marketing emails.
              Keep this current before sending campaigns to clients, leads, and event attendees.
            </p>
          </div>

          <Link
            href="/app/marketing/campaigns"
            className="inline-flex items-center justify-center rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            View Campaigns
          </Link>
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-2">
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
              Replies from campaign emails should go to the studio, not to DanceFlow support.
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
            <label htmlFor="marketingCity" className="text-sm font-medium text-slate-900">
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
            <label htmlFor="marketingState" className="text-sm font-medium text-slate-900">
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
            <label htmlFor="marketingCountry" className="text-sm font-medium text-slate-900">
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

        <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
          This address appears in marketing email footers. DanceFlow still suppresses unsubscribed contacts,
          and the studio remains responsible for sending campaigns only to contacts it is allowed to email.
        </div>

        <div className="mt-5">
          <button
            type="submit"
            className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
          >
            Save Marketing Footer
          </button>
        </div>
      </form>

      <SettingsForm
        studio={studio as StudioRow}
        settings={settings as StudioSettingsRow}
        notificationSettings={typedNotificationSettings}
        instructors={(instructors ?? []) as InstructorOption[]}
        rooms={(rooms ?? []) as RoomOption[]}
        role={context.studioRole ?? ""}
        billingSummary={billingSummary}
      />
    </div>
  );
}