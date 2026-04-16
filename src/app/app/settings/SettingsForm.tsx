"use client";

import { useActionState } from "react";
import { updateStudioSettingsAction } from "./actions";
import { updateStudioNotificationSettingsAction } from "./notification-actions";

const initialState = { error: "" };
const notificationInitialState = { error: "", success: "" };

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

function ToggleRow({
  title,
  description,
  name,
  defaultChecked,
  disabled,
}: {
  title: string;
  description: string;
  name: string;
  defaultChecked: boolean;
  disabled: boolean;
}) {
  return (
    <label className="flex items-start justify-between gap-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
      <div className="min-w-0">
        <p className="font-medium text-slate-900">{title}</p>
        <p className="mt-1 text-sm text-slate-600">{description}</p>
      </div>

      <input
        type="checkbox"
        name={name}
        defaultChecked={defaultChecked}
        disabled={disabled}
        className="mt-1 h-4 w-4 rounded border-slate-300 text-slate-900 disabled:opacity-60"
      />
    </label>
  );
}

function formatDateTime(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function formatStatus(value: string) {
  if (value === "trialing") return "Trialing";
  if (value === "active") return "Active";
  if (value === "past_due") return "Past Due";
  if (value === "cancelled") return "Cancelled";
  if (value === "inactive") return "Inactive";
  return value;
}

export default function SettingsForm({
  studio,
  settings,
  notificationSettings,
  instructors,
  rooms,
  role,
  billingSummary,
}: {
  studio: StudioRow;
  settings: StudioSettingsRow;
  notificationSettings: StudioNotificationSettingsRow;
  instructors: InstructorOption[];
  rooms: RoomOption[];
  role: string;
  billingSummary: BillingSummary;
}) {
  const [state, formAction, pending] = useActionState(
    updateStudioSettingsAction,
    initialState
  );

  const [notificationState, notificationFormAction, notificationPending] =
    useActionState(
      updateStudioNotificationSettingsAction,
      notificationInitialState
    );

  const canEdit = ["platform_admin", "studio_owner", "studio_admin"].includes(role);

  return (
    <div className="max-w-4xl">
      {!canEdit ? (
        <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          You can view settings, but only studio owners and admins can update them.
        </div>
      ) : null}

      <div className="mt-8 rounded-2xl border bg-white p-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <h3 className="text-xl font-semibold">Billing</h3>
            <p className="mt-2 text-sm text-slate-600">
              Manage your studio subscription, plan, renewal date, invoices, and payment method.
            </p>
          </div>

          <a
            href="/app/settings/billing"
            className="rounded-xl border px-4 py-2 hover:bg-slate-50"
          >
            Manage Billing
          </a>
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-xl border bg-slate-50 p-4">
            <p className="text-sm text-slate-500">Current Plan</p>
            <p className="mt-1 font-medium text-slate-900">
              {billingSummary.planName || "No plan"}
            </p>
          </div>

          <div className="rounded-xl border bg-slate-50 p-4">
            <p className="text-sm text-slate-500">Status</p>
            <p className="mt-1 font-medium text-slate-900">
              {formatStatus(billingSummary.status)}
            </p>
          </div>

          <div className="rounded-xl border bg-slate-50 p-4">
            <p className="text-sm text-slate-500">Billing Interval</p>
            <p className="mt-1 font-medium text-slate-900">
              {billingSummary.billingInterval === "year" ? "Yearly" : "Monthly"}
            </p>
          </div>

          <div className="rounded-xl border bg-slate-50 p-4">
            <p className="text-sm text-slate-500">Renews / Ends</p>
            <p className="mt-1 font-medium text-slate-900">
              {formatDateTime(billingSummary.currentPeriodEnd)}
            </p>
          </div>
        </div>

        <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
          {billingSummary.cancelAtPeriodEnd
            ? "This subscription is set to cancel at the end of the current billing period."
            : billingSummary.hasCustomer
            ? "Billing is connected and can be managed from the billing page."
            : "Billing has not been connected yet. Open billing to start your studio subscription."}
        </div>
      </div>

      <form action={formAction} className="mt-8 space-y-8">
        <div className="rounded-2xl border bg-white p-6">
          <h3 className="text-xl font-semibold">Studio Profile</h3>

          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <div>
              <label htmlFor="studioName" className="mb-1 block text-sm font-medium">
                Studio Name
              </label>
              <input
                id="studioName"
                name="studioName"
                defaultValue={studio.name}
                disabled={!canEdit}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 disabled:bg-slate-50"
              />
            </div>

            <div>
              <label htmlFor="timezone" className="mb-1 block text-sm font-medium">
                Timezone
              </label>
              <input
                id="timezone"
                name="timezone"
                defaultValue={settings.timezone ?? "America/New_York"}
                disabled={!canEdit}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 disabled:bg-slate-50"
              />
            </div>

            <div>
              <label htmlFor="currency" className="mb-1 block text-sm font-medium">
                Currency
              </label>
              <input
                id="currency"
                name="currency"
                defaultValue={settings.currency ?? "USD"}
                disabled={!canEdit}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 disabled:bg-slate-50"
              />
            </div>
          </div>
        </div>

        <div className="rounded-2xl border bg-white p-6">
          <h3 className="text-xl font-semibold">Booking Policies</h3>

          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <div>
              <label htmlFor="cancellationWindowHours" className="mb-1 block text-sm font-medium">
                Cancellation Window (Hours)
              </label>
              <input
                id="cancellationWindowHours"
                name="cancellationWindowHours"
                type="number"
                min="0"
                defaultValue={settings.cancellation_window_hours ?? 24}
                disabled={!canEdit}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 disabled:bg-slate-50"
              />
            </div>

            <div>
              <label htmlFor="bookingLeadTimeHours" className="mb-1 block text-sm font-medium">
                Booking Lead Time (Hours)
              </label>
              <input
                id="bookingLeadTimeHours"
                name="bookingLeadTimeHours"
                type="number"
                min="0"
                defaultValue={settings.booking_lead_time_hours ?? 0}
                disabled={!canEdit}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 disabled:bg-slate-50"
              />
            </div>
          </div>
        </div>

        <div className="rounded-2xl border bg-white p-6">
          <h3 className="text-xl font-semibold">Lesson & Balance Rules</h3>

          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <div>
              <label htmlFor="noShowDeductsLesson" className="mb-1 block text-sm font-medium">
                No-Show Deducts Lesson
              </label>
              <select
                id="noShowDeductsLesson"
                name="noShowDeductsLesson"
                defaultValue={settings.no_show_deducts_lesson ? "true" : "false"}
                disabled={!canEdit}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 disabled:bg-slate-50"
              >
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            </div>

            <div>
              <label htmlFor="allowNegativeBalance" className="mb-1 block text-sm font-medium">
                Allow Negative Balance
              </label>
              <select
                id="allowNegativeBalance"
                name="allowNegativeBalance"
                defaultValue={settings.allow_negative_balance ? "true" : "false"}
                disabled={!canEdit}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 disabled:bg-slate-50"
              >
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            </div>

            <div>
              <label
                htmlFor="blockDepletedPackageBooking"
                className="mb-1 block text-sm font-medium"
              >
                Depleted Package Booking
              </label>
              <select
                id="blockDepletedPackageBooking"
                name="blockDepletedPackageBooking"
                defaultValue={settings.block_depleted_package_booking ? "true" : "false"}
                disabled={!canEdit}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 disabled:bg-slate-50"
              >
                <option value="true">Block booking</option>
                <option value="false">Warn only</option>
              </select>
            </div>

            <div>
              <label
                htmlFor="warnLowPackageBalance"
                className="mb-1 block text-sm font-medium"
              >
                Low Balance Warning
              </label>
              <select
                id="warnLowPackageBalance"
                name="warnLowPackageBalance"
                defaultValue={settings.warn_low_package_balance ? "true" : "false"}
                disabled={!canEdit}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 disabled:bg-slate-50"
              >
                <option value="true">Show warning</option>
                <option value="false">Do not warn</option>
              </select>
            </div>
          </div>
        </div>

        <div className="rounded-2xl border bg-white p-6">
          <h3 className="text-xl font-semibold">Intro Lesson Booking</h3>
          <p className="mt-2 text-sm text-slate-600">
            Configure self-service intro lesson booking rules for the public booking flow.
          </p>

          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <div className="md:col-span-2">
              <label
                htmlFor="publicIntroBookingEnabled"
                className="mb-1 block text-sm font-medium"
              >
                Self-Service Intro Booking
              </label>
              <select
                id="publicIntroBookingEnabled"
                name="publicIntroBookingEnabled"
                defaultValue={settings.public_intro_booking_enabled ? "true" : "false"}
                disabled={!canEdit}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 disabled:bg-slate-50"
              >
                <option value="true">Enabled</option>
                <option value="false">Disabled</option>
              </select>
            </div>

            <div>
              <label
                htmlFor="introLessonDurationMinutes"
                className="mb-1 block text-sm font-medium"
              >
                Intro Lesson Duration (Minutes)
              </label>
              <input
                id="introLessonDurationMinutes"
                name="introLessonDurationMinutes"
                type="number"
                min="15"
                step="15"
                defaultValue={settings.intro_lesson_duration_minutes ?? 30}
                disabled={!canEdit}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 disabled:bg-slate-50"
              />
            </div>

            <div>
              <label
                htmlFor="introBookingWindowDays"
                className="mb-1 block text-sm font-medium"
              >
                Booking Window (Days Ahead)
              </label>
              <input
                id="introBookingWindowDays"
                name="introBookingWindowDays"
                type="number"
                min="1"
                defaultValue={settings.intro_booking_window_days ?? 7}
                disabled={!canEdit}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 disabled:bg-slate-50"
              />
            </div>

            <div>
              <label
                htmlFor="introDefaultInstructorId"
                className="mb-1 block text-sm font-medium"
              >
                Default Intro Instructor
              </label>
              <select
                id="introDefaultInstructorId"
                name="introDefaultInstructorId"
                defaultValue={settings.intro_default_instructor_id ?? ""}
                disabled={!canEdit}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 disabled:bg-slate-50"
              >
                <option value="">No default instructor</option>
                {instructors.map((instructor) => (
                  <option key={instructor.id} value={instructor.id}>
                    {instructor.first_name} {instructor.last_name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor="introDefaultRoomId"
                className="mb-1 block text-sm font-medium"
              >
                Default Intro Room
              </label>
              <select
                id="introDefaultRoomId"
                name="introDefaultRoomId"
                defaultValue={settings.intro_default_room_id ?? ""}
                disabled={!canEdit}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 disabled:bg-slate-50"
              >
                <option value="">No default room</option>
                {rooms.map((room) => (
                  <option key={room.id} value={room.id}>
                    {room.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <div className="rounded-2xl border bg-white p-6">
          <h3 className="text-xl font-semibold">Public Lead Branding</h3>

          <div className="mt-5 grid gap-4 md:grid-cols-2">
            <div className="md:col-span-2">
              <label htmlFor="publicLeadEnabled" className="mb-1 block text-sm font-medium">
                Public Booking
              </label>
              <select
                id="publicLeadEnabled"
                name="publicLeadEnabled"
                defaultValue={studio.public_lead_enabled ? "true" : "false"}
                disabled={!canEdit}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 disabled:bg-slate-50"
              >
                <option value="true">Enabled</option>
                <option value="false">Disabled</option>
              </select>
            </div>

            <div className="md:col-span-2">
              <label htmlFor="publicLeadHeadline" className="mb-1 block text-sm font-medium">
                Lead Page Headline
              </label>
              <input
                id="publicLeadHeadline"
                name="publicLeadHeadline"
                defaultValue={studio.public_lead_headline ?? ""}
                disabled={!canEdit}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 disabled:bg-slate-50"
              />
            </div>

            <div className="md:col-span-2">
              <label htmlFor="publicLeadDescription" className="mb-1 block text-sm font-medium">
                Lead Page Description
              </label>
              <textarea
                id="publicLeadDescription"
                name="publicLeadDescription"
                rows={4}
                defaultValue={studio.public_lead_description ?? ""}
                disabled={!canEdit}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 disabled:bg-slate-50"
              />
            </div>

            <div>
              <label htmlFor="publicLogoUrl" className="mb-1 block text-sm font-medium">
                Public Logo URL
              </label>
              <input
                id="publicLogoUrl"
                name="publicLogoUrl"
                defaultValue={studio.public_logo_url ?? ""}
                disabled={!canEdit}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 disabled:bg-slate-50"
              />
            </div>

            <div>
              <label htmlFor="publicPrimaryColor" className="mb-1 block text-sm font-medium">
                Brand Color
              </label>
              <input
                id="publicPrimaryColor"
                name="publicPrimaryColor"
                defaultValue={studio.public_primary_color ?? ""}
                disabled={!canEdit}
                placeholder="#0f172a"
                className="w-full rounded-xl border border-slate-300 px-3 py-2 disabled:bg-slate-50"
              />
            </div>

            <div className="md:col-span-2">
              <label htmlFor="publicLeadCtaText" className="mb-1 block text-sm font-medium">
                CTA Button Text
              </label>
              <input
                id="publicLeadCtaText"
                name="publicLeadCtaText"
                defaultValue={studio.public_lead_cta_text ?? ""}
                disabled={!canEdit}
                className="w-full rounded-xl border border-slate-300 px-3 py-2 disabled:bg-slate-50"
              />
            </div>
          </div>
        </div>

        {state?.error ? (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {state.error}
          </div>
        ) : null}

        {canEdit ? (
          <div className="flex gap-3">
            <button
              type="submit"
              disabled={pending}
              className="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800 disabled:opacity-60"
            >
              {pending ? "Saving..." : "Save Settings"}
            </button>
          </div>
        ) : null}
      </form>

      <form action={notificationFormAction} className="mt-8">
        <div className="rounded-2xl border bg-white p-6">
          <h3 className="text-xl font-semibold">Notification Preferences</h3>
          <p className="mt-2 text-sm text-slate-600">
            Choose which studio alerts should be generated and shown in the dashboard, bell menu, and notifications page.
          </p>

          <div className="mt-5 space-y-4">
            <ToggleRow
              title="Public intro booking alerts"
              description="Create a notification when a self-service intro lesson is booked."
              name="public_intro_booking_enabled"
              defaultChecked={notificationSettings.public_intro_booking_enabled}
              disabled={!canEdit || notificationPending}
            />

            <ToggleRow
              title="Overdue follow-up alerts"
              description="Create a notification when a lead follow-up due date has passed and is still incomplete."
              name="follow_up_overdue_enabled"
              defaultChecked={notificationSettings.follow_up_overdue_enabled}
              disabled={!canEdit || notificationPending}
            />

            <ToggleRow
              title="Low balance package alerts"
              description="Create a notification when a client package drops to 2 or fewer remaining in a finite item."
              name="package_low_balance_enabled"
              defaultChecked={notificationSettings.package_low_balance_enabled}
              disabled={!canEdit || notificationPending}
            />

            <ToggleRow
              title="Depleted package alerts"
              description="Create a notification when a client package reaches 0 remaining in a finite item."
              name="package_depleted_enabled"
              defaultChecked={notificationSettings.package_depleted_enabled}
              disabled={!canEdit || notificationPending}
            />
          </div>

          {notificationState?.error ? (
            <div className="mt-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {notificationState.error}
            </div>
          ) : null}

          {notificationState?.success ? (
            <div className="mt-5 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
              {notificationState.success}
            </div>
          ) : null}

          {canEdit ? (
            <div className="mt-6 flex gap-3">
              <button
                type="submit"
                disabled={notificationPending}
                className="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800 disabled:opacity-60"
              >
                {notificationPending ? "Saving..." : "Save Notification Preferences"}
              </button>
            </div>
          ) : null}
        </div>
      </form>
    </div>
  );
}