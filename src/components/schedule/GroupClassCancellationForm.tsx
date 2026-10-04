import { cancelGroupClassAppointmentAction } from "@/app/app/schedule/actions";
import { groupClassCancelConsequences } from "@/lib/schedule/groupClassCancel";
import {
  groupClassSeriesCancelImpactLines,
  type GroupClassSeriesPreview,
} from "@/lib/schedule/groupClassSeriesCancel";

type GroupClassCancellationFormProps = {
  appointmentId: string;
  returnTo: string;
  isSeriesOccurrence: boolean;
  /** Booked student count when the page already knows it; null when it does not. */
  bookedCount?: number | null;
  /**
   * GC-S1C-4: server-computed impact of "This and following classes" (preview RPC). When absent
   * (non-series class, or a list row that does not load it) only "This class" is offered.
   */
  seriesPreview?: GroupClassSeriesPreview | null;
  compact?: boolean;
};

/**
 * GC-S1C-2/4: the class-specific cancel control. A group class has no single client, requester,
 * reason or charge, so none of those are asked for. A series occurrence may be cancelled alone
 * ("This class") or together with every later class of its series ("This and following classes");
 * there is deliberately no "Entire series" choice because earlier classes are never rewritten. The
 * server (and the RPCs beneath it) is authoritative for who may cancel and for what is affected.
 */
export default function GroupClassCancellationForm({
  appointmentId,
  returnTo,
  isSeriesOccurrence,
  bookedCount = null,
  seriesPreview = null,
  compact = false,
}: GroupClassCancellationFormProps) {
  void compact;
  const offerSeries = isSeriesOccurrence && !!seriesPreview && seriesPreview.eligibleClassCount > 0;
  const lines = groupClassCancelConsequences({ bookedCount, isSeriesOccurrence });
  const seriesLines = offerSeries ? groupClassSeriesCancelImpactLines(seriesPreview) : [];

  return (
    <details className="w-full rounded-2xl border border-red-200 bg-red-50 p-4">
      <summary className="cursor-pointer list-none text-sm font-semibold text-red-800">
        {offerSeries ? "Cancel class or series" : "Cancel this class"}
      </summary>

      <form action={cancelGroupClassAppointmentAction} className="mt-4 space-y-3">
        <input type="hidden" name="appointmentId" value={appointmentId} />
        <input type="hidden" name="returnTo" value={returnTo} />

        {offerSeries ? (
          <fieldset className="space-y-2 text-sm text-red-900">
            <legend className="sr-only">Which classes to cancel</legend>
            <label className="flex items-start gap-2">
              <input type="radio" name="classCancelScope" value="this_class" defaultChecked className="mt-1" />
              <span>
                <span className="font-semibold">This class</span>
                <span className="block text-xs text-red-800">Other classes in the series stay scheduled.</span>
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input type="radio" name="classCancelScope" value="this_and_following" className="mt-1" />
              <span>
                <span className="font-semibold">This and following classes</span>
                <span className="block text-xs text-red-800">
                  {seriesPreview.eligibleClassCount}{" "}
                  {seriesPreview.eligibleClassCount === 1 ? "class" : "classes"}
                  {seriesPreview.dancersAffected > 0
                    ? `, ${seriesPreview.dancersAffected} ${seriesPreview.dancersAffected === 1 ? "dancer" : "dancers"} enrolled`
                    : ", no dancers booked"}
                </span>
              </span>
            </label>
          </fieldset>
        ) : null}

        <ul className="space-y-1 text-xs leading-5 text-red-800">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>

        {offerSeries ? (
          <div className="rounded-xl border border-red-200 bg-white/60 p-3">
            <p className="text-xs font-semibold text-red-900">If you choose &ldquo;This and following classes&rdquo;</p>
            <ul className="mt-1 space-y-1 text-xs leading-5 text-red-800">
              {seriesLines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <button
          type="submit"
          className="rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700"
        >
          Cancel classes
        </button>
      </form>
    </details>
  );
}
