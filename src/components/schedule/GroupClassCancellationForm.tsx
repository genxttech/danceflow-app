import { cancelGroupClassAppointmentAction } from "@/app/app/schedule/actions";
import { groupClassCancelConsequences } from "@/lib/schedule/groupClassCancel";

type GroupClassCancellationFormProps = {
  appointmentId: string;
  returnTo: string;
  isSeriesOccurrence: boolean;
  /** Booked student count when the page already knows it; null when it does not. */
  bookedCount?: number | null;
  compact?: boolean;
};

/**
 * GC-S1C-2: the class-specific cancel control. A group class has no single
 * client, requester, reason, charge or recurrence scope, so none of those are
 * asked for. Cancelling affects only this class; the server (and the
 * cancel_group_class_appointment RPC beneath it) is authoritative for who may
 * cancel and for refusing a class that already has attendance recorded.
 */
export default function GroupClassCancellationForm({
  appointmentId,
  returnTo,
  isSeriesOccurrence,
  bookedCount = null,
  compact = false,
}: GroupClassCancellationFormProps) {
  const lines = groupClassCancelConsequences({ bookedCount, isSeriesOccurrence });

  return (
    <details
      className={
        compact
          ? "w-full rounded-2xl border border-red-200 bg-red-50 p-4"
          : "w-full rounded-2xl border border-red-200 bg-red-50 p-4"
      }
    >
      <summary className="cursor-pointer list-none text-sm font-semibold text-red-800">
        Cancel this class
      </summary>

      <form action={cancelGroupClassAppointmentAction} className="mt-4 space-y-3">
        <input type="hidden" name="appointmentId" value={appointmentId} />
        <input type="hidden" name="returnTo" value={returnTo} />

        <ul className="space-y-1 text-xs leading-5 text-red-800">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>

        <button
          type="submit"
          className="rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700"
        >
          Cancel this class
        </button>
      </form>
    </details>
  );
}
