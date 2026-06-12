import {
  type SmsConsentStatus,
  type SmsPermissionRow,
  normalizeSmsPhone,
  SMS_CONSENT_DISCLOSURE,
  getSmsPlatformReadiness,
  smsConsentLabel,
  smsConsentTip,
} from "@/lib/sms/compliance";
import { updateClientSmsConsentAction } from "./sms-actions";

type ClientSmsConsentCardProps = {
  clientId: string;
  phone: string | null | undefined;
  permission?: SmsPermissionRow | null;
  canManage?: boolean;
  message?: string | null;
  error?: string | null;
};

function statusClasses(status: SmsConsentStatus) {
  if (status === "opted_in") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (status === "opted_out") return "border-red-200 bg-red-50 text-red-700";
  return "border-amber-200 bg-amber-50 text-amber-800";
}

export function ClientSmsConsentCard({
  clientId,
  phone,
  permission,
  canManage = false,
  message,
  error,
}: ClientSmsConsentCardProps) {
  const status = (permission?.consent_status ?? "unknown") as SmsConsentStatus;
  const smsReadiness = getSmsPlatformReadiness();
  const normalizedPhone = phone ? normalizeSmsPhone(phone) : null;
  const displayPhone = permission?.phone_e164 ?? normalizedPhone ?? phone ?? "No phone number saved";

  return (
    <section className="rounded-3xl border border-[var(--brand-border)] bg-white p-5 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-[var(--brand-muted)]">
            Text messaging
          </p>
          <h2 className="mt-2 text-xl font-bold text-[var(--brand-text)]">SMS consent</h2>
          <p className="mt-2 text-sm leading-6 text-[var(--brand-muted)]">
            Track whether this student has agreed to receive service-related text messages from your studio through DanceFlow.
          </p>
        </div>

        <div className={`rounded-2xl border px-3 py-2 text-sm font-bold ${statusClasses(status)}`}>
          {smsConsentLabel(status)}
        </div>
      </div>

      {!smsReadiness.canSend ? (
        <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900">
          <p className="font-semibold">Text messaging is not active yet.</p>
          <p className="mt-1">
            {smsReadiness.studioMessage} You can still record consent now so this student is ready once texting is available.
          </p>
        </div>
      ) : null}

      {message ? (
        <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800">
          {message}
        </div>
      ) : null}

      {error ? (
        <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
          {error}
        </div>
      ) : null}

      <div className="mt-4 rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-page-bg)] p-4">
        <p className="text-sm font-semibold text-[var(--brand-text)]">Phone</p>
        <p className="mt-1 text-sm text-[var(--brand-muted)]">{displayPhone}</p>
        <p className="mt-3 text-sm leading-6 text-[var(--brand-muted)]">{smsConsentTip(status)}</p>
      </div>

      <div className="mt-4 rounded-2xl border border-blue-100 bg-blue-50 p-4">
        <p className="text-sm font-semibold text-blue-950">Required consent language</p>
        <p className="mt-2 text-sm leading-6 text-blue-900">{SMS_CONSENT_DISCLOSURE}</p>
        <p className="mt-3 text-xs leading-5 text-blue-800">
          Consent must be optional and should only be marked opted in after the student has agreed to this disclosure.
        </p>
      </div>

      {canManage ? (
        <form action={updateClientSmsConsentAction} className="mt-5 space-y-4">
          <input type="hidden" name="clientId" value={clientId} />
          <input type="hidden" name="phone" value={phone ?? ""} />

          <label className="block text-sm font-semibold text-[var(--brand-text)]">
            SMS status
            <select
              name="consentStatus"
              defaultValue={status}
              className="mt-2 w-full rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-3 text-sm"
            >
              <option value="unknown">Consent needed</option>
              <option value="opted_in">Opted in</option>
              <option value="opted_out">Opted out</option>
            </select>
          </label>

          <label className="block text-sm font-semibold text-[var(--brand-text)]">
            Note
            <textarea
              name="consentNote"
              rows={3}
              placeholder="Example: Student agreed to the DanceFlow SMS disclosure during intake on June 12."
              className="mt-2 w-full rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-3 text-sm"
            />
          </label>

          <button
            type="submit"
            disabled={!phone}
            className="rounded-2xl bg-[var(--brand-primary)] px-5 py-3 text-sm font-bold text-white shadow-sm hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Save SMS consent
          </button>
        </form>
      ) : (
        <p className="mt-4 rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-page-bg)] px-4 py-3 text-sm text-[var(--brand-muted)]">
          Ask a studio owner, admin, or front desk user to update SMS consent after the student gives permission.
        </p>
      )}
    </section>
  );
}
