import {
  SMS_CAMPAIGN_USE_CASES,
  SMS_CAMPAIGN_USE_CASE_LABELS,
  SMS_PROVIDER_REVIEW_STATUSES,
  SMS_PROVIDER_REVIEW_STATUS_LABELS,
  SMS_REGISTRATION_STATUSES,
  SMS_REGISTRATION_STATUS_LABELS,
  evaluateSmsRegistrationReadiness,
  type SmsCampaignUseCase,
  type SmsProviderReviewStatus,
  type SmsRegistrationReadinessState,
  type SmsRegistrationStatus,
} from "@/lib/sms/registration";
import { saveStudioSmsRegistrationAction } from "./actions";

export type StudioOption = { id: string; name: string | null };

export type StudioSmsRegistrationRow = {
  id: string;
  studio_id: string;
  customer_profile_sid: string | null;
  brand_sid: string | null;
  brand_status: SmsProviderReviewStatus;
  messaging_service_sid: string | null;
  campaign_sid: string | null;
  campaign_status: SmsProviderReviewStatus;
  campaign_use_case: SmsCampaignUseCase | null;
  phone_number_sid: string | null;
  sender_e164: string | null;
  registration_status: SmsRegistrationStatus;
  approved_at: string | null;
  review_note: string | null;
  updated_at: string;
};

const inputClass =
  "mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900";
const labelClass = "block text-xs font-semibold text-slate-600";
const sectionTitleClass = "text-xs font-semibold uppercase tracking-[0.14em] text-slate-500 sm:col-span-2";

const READINESS_TONE: Record<SmsRegistrationReadinessState, string> = {
  ready: "bg-emerald-50 text-emerald-700",
  waiting_review: "bg-amber-50 text-amber-700",
  action_needed: "bg-rose-50 text-rose-700",
  blocked: "bg-rose-50 text-rose-700",
  incomplete: "bg-slate-100 text-slate-600",
};

export function readinessForRow(row: StudioSmsRegistrationRow) {
  return evaluateSmsRegistrationReadiness({
    registrationStatus: row.registration_status,
    customerProfileSid: row.customer_profile_sid,
    brandSid: row.brand_sid,
    brandStatus: row.brand_status ?? "not_started",
    messagingServiceSid: row.messaging_service_sid,
    campaignSid: row.campaign_sid,
    campaignStatus: row.campaign_status ?? "not_started",
    campaignUseCase: row.campaign_use_case,
    phoneNumberSid: row.phone_number_sid,
    senderE164: row.sender_e164,
  });
}

function SidInput({
  label,
  name,
  placeholder,
  value,
}: {
  label: string;
  name: string;
  placeholder: string;
  value: string | null | undefined;
}) {
  return (
    <label className={labelClass}>
      {label}
      <input
        name={name}
        defaultValue={value ?? ""}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        className={inputClass}
      />
    </label>
  );
}

function ReviewStatusSelect({
  label,
  name,
  value,
}: {
  label: string;
  name: string;
  value: SmsProviderReviewStatus | undefined;
}) {
  return (
    <label className={labelClass}>
      {label}
      <select name={name} defaultValue={value ?? "not_started"} className={inputClass}>
        {SMS_PROVIDER_REVIEW_STATUSES.map((status) => (
          <option key={status} value={status}>
            {SMS_PROVIDER_REVIEW_STATUS_LABELS[status]}
          </option>
        ))}
      </select>
    </label>
  );
}

function ReadinessPanel({ row }: { row: StudioSmsRegistrationRow }) {
  const readiness = readinessForRow(row);
  const actionNeeded = readiness.state === "action_needed" || readiness.state === "blocked";

  return (
    <div
      className={`mt-4 rounded-xl border px-3 py-2 text-sm ${
        actionNeeded ? "border-rose-200 bg-rose-50" : "border-slate-200 bg-slate-50"
      }`}
    >
      <p className="font-semibold text-slate-900">
        {readiness.label} · App sending {readiness.canSend ? "enabled" : "blocked"}
      </p>
      <p className="mt-1 text-xs leading-5 text-slate-600">{readiness.guidance}</p>
      {readiness.missing.length > 0 && !actionNeeded ? (
        <p className="mt-1 text-xs leading-5 text-slate-600">
          Missing: {readiness.missing.join(", ")}
        </p>
      ) : null}
    </div>
  );
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
      <p className={sectionTitleClass}>Studio</p>
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

      <p className={sectionTitleClass}>Twilio registration</p>
      <SidInput label="Customer Profile SID" name="customerProfileSid" placeholder="BU…" value={row?.customer_profile_sid} />
      <SidInput label="Brand SID" name="brandSid" placeholder="BN…" value={row?.brand_sid} />
      <ReviewStatusSelect label="Brand status" name="brandStatus" value={row?.brand_status} />
      <SidInput label="Messaging Service SID" name="messagingServiceSid" placeholder="MG…" value={row?.messaging_service_sid} />
      <SidInput label="Campaign SID" name="campaignSid" placeholder="QE…" value={row?.campaign_sid} />
      <ReviewStatusSelect label="Campaign status" name="campaignStatus" value={row?.campaign_status} />
      <label className={labelClass}>
        Campaign use case
        <select name="campaignUseCase" defaultValue={row?.campaign_use_case ?? ""} className={inputClass}>
          <option value="">Not selected</option>
          {SMS_CAMPAIGN_USE_CASES.map((useCase) => (
            <option key={useCase} value={useCase}>
              {SMS_CAMPAIGN_USE_CASE_LABELS[useCase]}
            </option>
          ))}
        </select>
      </label>
      <SidInput label="Phone Number SID" name="phoneNumberSid" placeholder="PN…" value={row?.phone_number_sid} />
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

      <p className={sectionTitleClass}>Status / readiness</p>
      <label className={labelClass}>
        Overall setup status
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
      <p className="self-end text-xs leading-5 text-slate-500">
        Approved needs every identifier above plus Brand and Campaign approved.
      </p>

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
        Each studio is registered as its own campaign under DanceFlow. Register in the Twilio Console
        (Customer Profile → Brand → Messaging Service → Campaign → sender number), then record the
        studio&apos;s identifiers and statuses here. Recording a registration does not turn texting on.
        Only non-secret identifiers belong here — never an auth token or API key.
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
          registrations.map((row) => {
            const readiness = readinessForRow(row);
            return (
              <details key={row.id} className="group bg-white px-4 py-3">
                <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold text-slate-950">
                    {studioNames.get(row.studio_id) ?? "Studio"}
                  </span>
                  <span className="flex items-center gap-3 text-xs text-slate-500">
                    {row.sender_e164 ?? "No sender yet"}
                    <span
                      className={`rounded-full px-2.5 py-1 font-semibold ${READINESS_TONE[readiness.state]}`}
                    >
                      {readiness.label}
                    </span>
                    <span className="font-semibold text-slate-400 group-open:text-slate-900">Edit</span>
                  </span>
                </summary>
                <ReadinessPanel row={row} />
                <RegistrationForm studios={studios} row={row} />
              </details>
            );
          })
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
