import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import SettingsForm from "./SettingsForm";
import { canManageSettings } from "@/lib/auth/permissions";
import { getCurrentStudioContext } from "@/lib/auth/studio";

type StudioRow = {
  id: string;
  name: string;
  public_lead_enabled: boolean;
  public_lead_headline: string | null;
  public_lead_description: string | null;
  public_logo_url: string | null;
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
        public_lead_enabled,
        public_lead_headline,
        public_lead_description,
        public_logo_url,
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
      <div className="rounded-2xl border bg-white p-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-slate-900">
              Settings
            </h1>
            <p className="mt-2 text-slate-600">
              Manage studio policies, branding, notifications, billing access, and data import.
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <Link
              href="/app/settings/import"
              className="rounded-xl border px-4 py-2 hover:bg-slate-50"
            >
              Open Import
            </Link>

            <Link
              href="/app/settings/billing"
              className="rounded-xl border px-4 py-2 hover:bg-slate-50"
            >
              Open Billing
            </Link>
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Link
          href="/app/settings/import"
          className="rounded-2xl border bg-white p-5 transition hover:bg-slate-50"
        >
          <p className="text-sm font-medium text-slate-500">Data Import</p>
          <h2 className="mt-2 text-xl font-semibold text-slate-900">
            Import existing studio data
          </h2>
          <p className="mt-2 text-sm text-slate-600">
            Upload CSV files, review import history, and prepare migrations from another system.
          </p>
        </Link>

        <Link
          href="/app/settings/billing"
          className="rounded-2xl border bg-white p-5 transition hover:bg-slate-50"
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