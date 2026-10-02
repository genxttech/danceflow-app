import {
  SMS_REGISTRATION_STATUSES,
  SMS_REGISTRATION_STATUS_LABELS,
  type SmsRegistrationStatus,
} from "@/lib/sms/registration";
import { saveStudioSmsRegistrationAction } from "./actions";

export type StudioOption = { id: string; name: string | null };

export type StudioSmsRegistrationRow = {
  id: string;
  studio_id: string;
  messaging_service_sid: string | null;
  campaign_sid: string | null;
  sender_e164: string | null;
  registration_status: SmsRegistrationStatus;
  approved_at: string | null;
  review_note: string | null;
  updated_at: string;
};

const inputClass =
  "mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900";
const labelClass = "block text-xs font-semibold text-slate-600";

function statusTone(status: SmsRegistrationStatus) {
  if (status === "approved") return "bg-emerald-50 text-emerald-700";
  if (status === "in_review") return "bg-amber-50 text-amber-700";
  if (status === "rejected" || status === "suspended") return "bg-rose-50 text-rose-700";
  return "bg-slate-100 text-slate-600";
}

function RegistrationForm({
  studios,
  row,
}: {
  studios: StudioOption[];
  row?: StudioSmsRegistrationRow;
}) {
  return (
    <form action={saveStudioSmsRegistrationAction} className="mt-4 grid gap-3 sm:grid-cols-2">
      {row ? (
        <input type="hidden" name="studioId" value={row.studio_id} />
      ) : (
        <label className={`${labelClass} sm:col-span-2`}>
          Studio
          <select name="studioId" required defaultValue="" className={inputClass}>
            <option value="" disabled>
              Choose a studio
            </option>
            {studios.map((studio) => (
              <option key={studio.id} value={studio.id}>
                {studio.name ?? "Unnamed studio"}
              </option>
            ))}
          </select>
        </label>
      )}

      <label className={labelClass}>
        Status
        <select
          name="registrationStatus"
          defaultValue={row?.registration_status ?? "not_registered"}
          className={inputClass}
        >
          {SMS_REGISTRATION_STATUSES.map((status) => (
            <option key={status} value={status}>
              {SMS_REGISTRATION_STATUS_LABELS[status]}
            </option>
          ))}
        </select>
      </label>

      <label className={labelClass}>
        Sender number
        <input
          name="senderE164"
          defaultValue={row?.sender_e164 ?? ""}
          placeholder="+15555550123"
          autoComplete="off"
          className={inputClass}
        />
      </label>

      <label className={labelClass}>
        Messaging Service SID
        <input
          name="messagingServiceSid"
          defaultValue={row?.messaging_service_sid ?? ""}
          placeholder="MG…"
          autoComplete="off"
          spellCheck={false}
          className={inputClass}
        />
      </label>

      <label className={labelClass}>
        Campaign SID
        <input
          name="campaignSid"
          defaultValue={row?.campaign_sid ?? ""}
          placeholder="QE…"
          autoComplete="off"
          spellCheck={false}
          className={inputClass}
        />
      </label>

      <label className={`${labelClass} sm:col-span-2`}>
        Note (optional)
        <textarea
          name="reviewNote"
          rows={2}
          maxLength={500}
          defaultValue={row?.review_note ?? ""}
          className={inputClass}
        />
      </label>

      <div className="sm:col-span-2">
        <button
          type="submit"
          className="rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
        >
          Save registration
        </button>
      </div>
    </form>
  );
}

export default function StudioSmsRegistrations({
  studios,
  registrations,
  notice,
  error,
}: {
  studios: StudioOption[];
  registrations: StudioSmsRegistrationRow[];
  notice: boolean;
  error: string | null;
}) {
  const studioNames = new Map(studios.map((studio) => [studio.id, studio.name ?? "Unnamed studio"]));
  const registeredIds = new Set(registrations.map((row) => row.studio_id));
  const unregistered = studios.filter((studio) => !registeredIds.has(studio.id));

  return (
    <section
      id="registrations"
      className="rounded-[1.5rem] border border-slate-200 bg-white p-5 shadow-sm"
    >
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
        Studio registrations
      </p>
      <h2 className="mt-2 text-xl font-semibold tracking-tight text-slate-950">
        Per-studio A2P status
      </h2>
      <p className="mt-2 text-sm leading-6 text-slate-600">
        Each studio is registered as its own campaign under DanceFlow. Register in Twilio, then
        record the studio&apos;s status and identifiers here. Recording a registration does not turn
        texting on.
      </p>

      {notice ? (
        <p className="mt-4 rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          Registration saved.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-4 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {error.slice(0, 200)}
        </p>
      ) : null}

      <div className="mt-5 divide-y divide-slate-200 overflow-hidden rounded-2xl border border-slate-200">
        {registrations.length === 0 ? (
          <p className="bg-slate-50 px-4 py-6 text-sm text-slate-600">
            No studio registrations yet. Add the first one below.
          </p>
        ) : (
          registrations.map((row) => (
            <details key={row.id} className="group bg-white px-4 py-3">
              <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-slate-950">
                  {studioNames.get(row.studio_id) ?? "Studio"}
                </span>
                <span className="flex items-center gap-3 text-xs text-slate-500">
                  {row.sender_e164 ?? "No sender yet"}
                  <span
                    className={`rounded-full px-2.5 py-1 font-semibold ${statusTone(row.registration_status)}`}
                  >
                    {SMS_REGISTRATION_STATUS_LABELS[row.registration_status]}
                  </span>
                  <span className="font-semibold text-slate-400 group-open:text-slate-900">Edit</span>
                </span>
              </summary>
              <RegistrationForm studios={studios} row={row} />
            </details>
          ))
        )}
      </div>

      {unregistered.length > 0 ? (
        <details className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
          <summary className="cursor-pointer text-sm font-semibold text-slate-900">
            Add a studio registration
          </summary>
          <RegistrationForm studios={unregistered} />
        </details>
      ) : null}
    </section>
  );
}
