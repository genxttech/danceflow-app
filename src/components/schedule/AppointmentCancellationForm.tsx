"use client";

import { cancelAppointmentAction } from "@/app/app/schedule/actions";

type AppointmentCancellationFormProps = {
  appointmentId: string;
  returnTo: string;
  isRecurring: boolean;
  isFloorRental?: boolean;
  compact?: boolean;
};

export default function AppointmentCancellationForm({
  appointmentId,
  returnTo,
  isRecurring,
  isFloorRental = false,
  compact = false,
}: AppointmentCancellationFormProps) {
  const prefix = `cancel-${appointmentId}`;
  const title = isFloorRental ? "Cancel Rental" : "Cancel Appointment";

  return (
    <details
      className={
        compact
          ? "w-full rounded-2xl border border-red-200 bg-red-50 p-4"
          : "w-full rounded-2xl border border-red-200 bg-red-50 p-4"
      }
    >
      <summary className="cursor-pointer list-none text-sm font-semibold text-red-800">
        {title}
      </summary>

      <form action={cancelAppointmentAction} className="mt-4 space-y-4">
        <input type="hidden" name="appointmentId" value={appointmentId} />
        <input type="hidden" name="returnTo" value={returnTo} />

        {isRecurring ? (
          <div>
            <label
              htmlFor={`${prefix}-scope`}
              className="text-sm font-medium text-slate-900"
            >
              Cancellation scope
            </label>
            <select
              id={`${prefix}-scope`}
              name="cancelScope"
              defaultValue="this_instance"
              className="mt-2 w-full rounded-xl border border-red-200 bg-white px-3 py-2 text-sm"
            >
              <option value="this_instance">This appointment only</option>
              <option value="this_and_future">
                This and all future appointments in the series
              </option>
            </select>
          </div>
        ) : (
          <input type="hidden" name="cancelScope" value="this_instance" />
        )}

        <div>
          <label
            htmlFor={`${prefix}-requested-by`}
            className="text-sm font-medium text-slate-900"
          >
            Who requested the cancellation?
          </label>
          <select
            id={`${prefix}-requested-by`}
            name="cancellationRequestedBy"
            defaultValue=""
            required
            className="mt-2 w-full rounded-xl border border-red-200 bg-white px-3 py-2 text-sm"
          >
            <option value="" disabled>
              Select requester
            </option>
            <option value="client">Client</option>
            <option value="instructor">Instructor</option>
            <option value="studio">Studio</option>
            <option value="other">Other</option>
          </select>
        </div>

        <div>
          <label
            htmlFor={`${prefix}-reason`}
            className="text-sm font-medium text-slate-900"
          >
            Cancellation reason
          </label>
          <textarea
            id={`${prefix}-reason`}
            name="cancellationReason"
            rows={compact ? 4 : 6}
            maxLength={2000}
            required
            className="mt-2 w-full rounded-xl border border-red-200 bg-white px-3 py-2 text-sm"
            placeholder="Enter the full reason for the cancellation, including any follow-up or rescheduling details."
          />
        </div>

        <div>
          <label
            htmlFor={`${prefix}-charge`}
            className="text-sm font-medium text-slate-900"
          >
            Short-notice charge
          </label>
          <select
            id={`${prefix}-charge`}
            name="missedAppointmentCharge"
            defaultValue="none"
            className="mt-2 w-full rounded-xl border border-red-200 bg-white px-3 py-2 text-sm"
          >
            <option value="none">Do not deduct a lesson</option>
            <option value="package">Deduct one package credit</option>
            <option value="membership">Deduct one membership benefit</option>
          </select>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            Use a deduction only when the studio&apos;s cancellation policy treats
            the missed lesson as used.
          </p>
        </div>

        <p className="text-xs leading-5 text-red-700">
          The cancellation and charge decision will be saved to the client&apos;s
          Notes / Activity ledger.
        </p>

        <button
          type="submit"
          className="rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700"
        >
          Confirm Cancellation
        </button>
      </form>
    </details>
  );
}
