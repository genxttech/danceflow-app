"use client";

import Link from "next/link";
import Image from "next/image";
import { useActionState } from "react";
import { updateStudioSettingsAction } from "./actions";
import { updateStudioNotificationSettingsAction } from "./notification-actions";

type Props = {
  studio: { id: string; name: string };
  settings: {
    lumi_enabled: boolean | null; timezone: string | null; currency: string | null;
    cancellation_window_hours: number | null; booking_lead_time_hours: number | null;
    no_show_deducts_lesson: boolean | null; allow_negative_balance: boolean | null;
    block_depleted_package_booking: boolean | null; warn_low_package_balance: boolean | null;
    portal_self_scheduling_enabled: boolean | null; portal_self_scheduling_mode: string | null;
    portal_self_scheduling_window_days: number | null; portal_self_scheduling_min_notice_hours: number | null;
    portal_self_scheduling_cancellation_cutoff_hours: number | null;
    portal_bookable_instructor_ids: string[] | null; portal_bookable_lesson_types: string[] | null;
  };
  notificationSettings: { public_intro_booking_enabled: boolean; follow_up_overdue_enabled: boolean; package_low_balance_enabled: boolean; package_depleted_enabled: boolean; floor_rental_upcoming_enabled: boolean };
  instructors: { id: string; first_name: string; last_name: string }[];
  role: string;
  billingSummary: { hasCustomer: boolean; planName: string; status: string; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean };
  lumiAvailable: boolean;
};

const lessonTypes = [["private_lesson", "Private lessons"], ["coaching", "Coachings"], ["practice_party", "Practice parties"], ["group_class", "Group classes"]];
const fieldClass = "mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 disabled:bg-slate-50";

function Toggle({ name, title, description, checked, disabled }: { name: string; title: string; description: string; checked: boolean; disabled: boolean }) {
  return <label className="flex items-start justify-between gap-4 rounded-lg border border-slate-200 p-4"><span><span className="block font-medium text-slate-900">{title}</span><span className="mt-1 block text-sm text-slate-600">{description}</span></span><input type="checkbox" name={name} defaultChecked={checked} disabled={disabled} className="mt-1 h-4 w-4 rounded" /></label>;
}

export default function SettingsForm({ studio, settings, notificationSettings, instructors, role, billingSummary, lumiAvailable }: Props) {
  const [state, action, pending] = useActionState(updateStudioSettingsAction, { error: "" });
  const [notificationState, notificationAction, notificationPending] = useActionState(updateStudioNotificationSettingsAction, { error: "", success: "" });
  const canEdit = ["platform_admin", "studio_owner", "studio_admin"].includes(role);
  const portalInstructors = settings.portal_bookable_instructor_ids ?? [];
  const portalTypes = settings.portal_bookable_lesson_types?.length ? settings.portal_bookable_lesson_types : ["private_lesson"];

  return <div className="max-w-5xl space-y-6">
    <form action={action} className="space-y-6">
      <section className="overflow-hidden rounded-lg border border-fuchsia-200 bg-[#2D0B45] text-white shadow-sm"><div className="grid md:grid-cols-[180px_1fr]"><div className="relative min-h-52 bg-fuchsia-950"><Image src="/lumi-avatar.png" alt="LUMI, Dance Journey Assistant" fill sizes="(max-width: 768px) 100vw, 180px" className="object-cover object-top" /></div><div className="p-6"><p className="text-xs font-semibold uppercase tracking-wider text-fuchsia-200">AI assistant</p><h2 className="mt-1 text-2xl font-semibold">LUMI Dance Journey Assistant</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-white/75">Student guidance based on studio learning records, goals, lesson recaps, and syllabus progress.</p><label className="mt-5 block text-sm font-medium">Student portal access<select name="lumiEnabled" defaultValue={settings.lumi_enabled ? "true" : "false"} disabled={!canEdit || !lumiAvailable} className="mt-2 w-full rounded-lg border border-white/20 bg-white px-3 py-2 text-slate-900 disabled:opacity-60"><option value="false">Disabled</option><option value="true">Enabled</option></select></label>{!lumiAvailable ? <p className="mt-2 text-xs text-fuchsia-200">Available on Growth and Pro plans.</p> : null}</div></div></section>

      <section className="rounded-lg border border-l-4 border-l-violet-600 bg-white p-6 shadow-sm"><p className="text-xs font-semibold uppercase tracking-wider text-violet-700">Core setup</p><h2 className="mt-1 text-xl font-semibold">Studio operations</h2><p className="mt-1 text-sm text-slate-600">Core defaults used throughout the staff application.</p><div className="mt-5 grid gap-4 md:grid-cols-3">
        <label className="text-sm font-medium">Studio name<input name="studioName" defaultValue={studio.name} disabled={!canEdit} className={fieldClass} /></label>
        <label className="text-sm font-medium">Timezone<input name="timezone" defaultValue={settings.timezone ?? "America/New_York"} disabled={!canEdit} className={fieldClass} /></label>
        <label className="text-sm font-medium">Currency<input name="currency" defaultValue={settings.currency ?? "USD"} disabled={!canEdit} className={fieldClass} /></label>
      </div></section>

      <section className="rounded-lg border border-l-4 border-l-orange-500 bg-white p-6 shadow-sm"><p className="text-xs font-semibold uppercase tracking-wider text-orange-700">Rules</p><h2 className="mt-1 text-xl font-semibold">Booking policies</h2><div className="mt-5 grid gap-4 md:grid-cols-2">
        <label className="text-sm font-medium">Cancellation window (hours)<input type="number" min="0" name="cancellationWindowHours" defaultValue={settings.cancellation_window_hours ?? 24} disabled={!canEdit} className={fieldClass} /></label>
        <label className="text-sm font-medium">Booking lead time (hours)<input type="number" min="0" name="bookingLeadTimeHours" defaultValue={settings.booking_lead_time_hours ?? 0} disabled={!canEdit} className={fieldClass} /></label>
        <label className="text-sm font-medium">No-show handling<select name="noShowDeductsLesson" defaultValue={settings.no_show_deducts_lesson ? "true" : "false"} disabled={!canEdit} className={fieldClass}><option value="true">Deduct lesson</option><option value="false">Do not deduct</option></select></label>
        <label className="text-sm font-medium">Negative balances<select name="allowNegativeBalance" defaultValue={settings.allow_negative_balance ? "true" : "false"} disabled={!canEdit} className={fieldClass}><option value="false">Prevent</option><option value="true">Allow</option></select></label>
        <label className="text-sm font-medium">Depleted packages<select name="blockDepletedPackageBooking" defaultValue={settings.block_depleted_package_booking ? "true" : "false"} disabled={!canEdit} className={fieldClass}><option value="true">Block booking</option><option value="false">Warn only</option></select></label>
        <label className="text-sm font-medium">Low balance warning<select name="warnLowPackageBalance" defaultValue={settings.warn_low_package_balance ? "true" : "false"} disabled={!canEdit} className={fieldClass}><option value="true">Show warning</option><option value="false">Do not warn</option></select></label>
      </div></section>

      <section className="rounded-lg border border-l-4 border-l-sky-500 bg-white p-6 shadow-sm"><p className="text-xs font-semibold uppercase tracking-wider text-sky-700">Student experience</p><h2 className="mt-1 text-xl font-semibold">Student portal scheduling</h2><p className="mt-1 text-sm text-slate-600">Control request-based scheduling for existing students. Public intro booking is configured under Public Presence &amp; Booking.</p><div className="mt-5 grid gap-4 md:grid-cols-2">
        <label className="text-sm font-medium">Schedule requests<select name="portalSelfSchedulingEnabled" defaultValue={settings.portal_self_scheduling_enabled ? "true" : "false"} disabled={!canEdit} className={fieldClass}><option value="false">Disabled</option><option value="true">Enabled</option></select></label>
        <label className="text-sm font-medium">Mode<select name="portalSelfSchedulingMode" defaultValue={settings.portal_self_scheduling_mode ?? "request_only"} disabled={!canEdit} className={fieldClass}><option value="request_only">Request only</option><option value="disabled">Disabled</option></select></label>
        <label className="text-sm font-medium">Request window (days)<input type="number" min="1" name="portalSelfSchedulingWindowDays" defaultValue={settings.portal_self_scheduling_window_days ?? 14} disabled={!canEdit} className={fieldClass} /></label>
        <label className="text-sm font-medium">Minimum notice (hours)<input type="number" min="0" name="portalSelfSchedulingMinNoticeHours" defaultValue={settings.portal_self_scheduling_min_notice_hours ?? 24} disabled={!canEdit} className={fieldClass} /></label>
        <label className="text-sm font-medium">Cancellation cutoff (hours)<input type="number" min="0" name="portalSelfSchedulingCancellationCutoffHours" defaultValue={settings.portal_self_scheduling_cancellation_cutoff_hours ?? 24} disabled={!canEdit} className={fieldClass} /></label>
      </div><fieldset className="mt-5"><legend className="text-sm font-medium">Requestable lesson types</legend><div className="mt-2 grid gap-2 md:grid-cols-2">{lessonTypes.map(([value,label]) => <label key={value} className="rounded-lg border p-3 text-sm"><input type="checkbox" name="portalBookableLessonTypes" value={value} defaultChecked={portalTypes.includes(value)} disabled={!canEdit} className="mr-2" />{label}</label>)}</div></fieldset><fieldset className="mt-5"><legend className="text-sm font-medium">Requestable instructors</legend><div className="mt-2 grid gap-2 md:grid-cols-2">{instructors.map((item) => <label key={item.id} className="rounded-lg border p-3 text-sm"><input type="checkbox" name="portalBookableInstructorIds" value={item.id} defaultChecked={portalInstructors.includes(item.id)} disabled={!canEdit} className="mr-2" />{item.first_name} {item.last_name}</label>)}</div></fieldset></section>

      {state.error ? <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{state.error}</p> : null}
      {canEdit ? <button disabled={pending} className="rounded-lg bg-[#2D0B45] px-5 py-3 text-sm font-semibold text-white disabled:opacity-60">{pending ? "Saving..." : "Save operational settings"}</button> : null}
    </form>

    <section className="rounded-lg border border-l-4 border-l-emerald-500 bg-white p-6 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-xl font-semibold">Billing</h2><p className="mt-1 text-sm text-slate-600">{billingSummary.planName} plan · {billingSummary.status}</p></div><Link href="/app/settings/billing" className="rounded-lg border px-4 py-2 text-sm font-semibold">Manage billing</Link></div>
      {billingSummary.cancelAtPeriodEnd ? <p className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">The subscription will end after the current billing period.</p> : null}
    </section>

    <form action={notificationAction}><section className="rounded-lg border border-l-4 border-l-amber-500 bg-white p-6 shadow-sm"><p className="text-xs font-semibold uppercase tracking-wider text-amber-700">Alerts</p><h2 className="mt-1 text-xl font-semibold">Notification preferences</h2><div className="mt-5 space-y-3">
      <Toggle name="public_intro_booking_enabled" title="Public intro booking alerts" description="Alert staff when a new intro request arrives." checked={notificationSettings.public_intro_booking_enabled} disabled={!canEdit || notificationPending} />
      <Toggle name="follow_up_overdue_enabled" title="Overdue follow-ups" description="Alert staff when a lead follow-up becomes overdue." checked={notificationSettings.follow_up_overdue_enabled} disabled={!canEdit || notificationPending} />
      <Toggle name="package_low_balance_enabled" title="Low package balances" description="Alert staff when a finite package reaches two remaining items." checked={notificationSettings.package_low_balance_enabled} disabled={!canEdit || notificationPending} />
      <Toggle name="package_depleted_enabled" title="Depleted packages" description="Alert staff when a finite package reaches zero." checked={notificationSettings.package_depleted_enabled} disabled={!canEdit || notificationPending} />
      <Toggle name="floor_rental_upcoming_enabled" title="Upcoming floor rentals" description="Alert staff about rentals beginning within 24 hours." checked={notificationSettings.floor_rental_upcoming_enabled} disabled={!canEdit || notificationPending} />
    </div>{notificationState.error ? <p className="mt-4 text-sm text-red-700">{notificationState.error}</p> : null}{notificationState.success ? <p className="mt-4 text-sm text-emerald-700">{notificationState.success}</p> : null}{canEdit ? <button disabled={notificationPending} className="mt-5 rounded-lg border px-4 py-2 text-sm font-semibold">{notificationPending ? "Saving..." : "Save notifications"}</button> : null}</section></form>
  </div>;
}
