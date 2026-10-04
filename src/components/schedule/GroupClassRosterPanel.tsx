import Link from "next/link";
import { cancelClassAttendeeAction } from "@/app/app/schedule/actions";
import type { RosterEntry, RosterPanelData } from "@/lib/schedule/groupClassRosterPanel";
import AddDancerPanel from "./AddDancerPanel";
import RosterSubmitButton from "./RosterSubmitButton";

type ClosedReason = "cancelled" | "ended" | null;

function chipClass(entry: RosterEntry) {
  if (entry.enrollment === "removed") return "bg-slate-100 text-slate-600";
  if (entry.attendanceStatus === "attended") return "bg-emerald-50 text-emerald-700";
  if (entry.attendanceStatus === "no_show") return "bg-orange-50 text-orange-700";
  if (entry.attendanceStatus === "checked_in") return "bg-indigo-50 text-indigo-700";
  return "bg-green-50 text-green-700";
}

function chipLabel(entry: RosterEntry) {
  if (entry.enrollment === "removed") return "Removed";
  return entry.attendanceLabel && entry.attendanceStatus !== "registered" ? entry.attendanceLabel : "Enrolled";
}

function RemoveControl({ entry, appointmentId, returnTo }: { entry: RosterEntry; appointmentId: string; returnTo: string }) {
  return (
    <details className="relative text-right">
      <summary className="cursor-pointer list-none text-xs font-semibold text-red-700 underline [&::-webkit-details-marker]:hidden">
        Remove
      </summary>
      <form
        action={cancelClassAttendeeAction}
        className="mt-2 w-64 max-w-full space-y-2 rounded-xl border border-red-200 bg-red-50 p-3 text-left text-xs text-red-900 sm:absolute sm:right-0 sm:z-10"
      >
        <input type="hidden" name="appointmentId" value={appointmentId} />
        <input type="hidden" name="attendeeId" value={entry.attendeeId} />
        <input type="hidden" name="returnTo" value={returnTo} />
        <p>
          Remove <span className="font-semibold">{entry.name}</span> from this class? They will no longer be enrolled. No
          credit is used or returned, and this frees a seat.
        </p>
        <RosterSubmitButton
          label="Remove from class"
          pendingLabel="Removing…"
          className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-700"
        />
      </form>
    </details>
  );
}

/**
 * GC-S1D-1: the roster section of a single group-class occurrence. Enrollment lives here (add / remove); attendance is
 * shown read-only with a link to the attendance workflow; funding is a concise label (broad staff only) and never a
 * payment action. Authority is the database's (broad staff, or the assigned instructor for their own class).
 */
export default function GroupClassRosterPanel({
  appointmentId,
  returnTo,
  roster,
  canManage,
  isBroadStaff,
  closedReason,
  reopenAdd = false,
}: {
  appointmentId: string;
  returnTo: string;
  roster: RosterPanelData;
  canManage: boolean;
  isBroadStaff: boolean;
  closedReason: ClosedReason;
  /** Reopen the Add dancer control (after an add-dancer refusal). */
  reopenAdd?: boolean;
}) {
  const { capacity } = roster;
  const full = capacity.state === "full" || capacity.state === "over";
  const percent =
    capacity.seatsLeft === null ? null : Math.min(100, Math.round((roster.bookedCount / (roster.bookedCount + capacity.seatsLeft || 1)) * 100));

  return (
    <section id="roster" className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm" aria-labelledby="roster-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="roster-heading" className="text-xl font-semibold text-slate-900">{capacity.headline}</h3>
          <p
            className={
              capacity.state === "full" || capacity.state === "over"
                ? "mt-1 text-sm font-medium text-amber-700"
                : "mt-1 text-sm text-slate-600"
            }
          >
            {capacity.detail}
          </p>
        </div>
        <Link
          href={`/app/schedule/${appointmentId}/attendance`}
          className="rounded-xl border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Take attendance
        </Link>
      </div>

      {percent !== null ? (
        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
          <div className={full ? "h-full bg-amber-500" : "h-full bg-indigo-500"} style={{ width: `${percent}%` }} />
        </div>
      ) : null}

      {roster.entries.length === 0 ? (
        <p className="mt-5 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-6 text-center text-sm text-slate-600">
          No dancers are enrolled yet.
          {canManage && !closedReason ? " Use Add dancer below." : ""}
        </p>
      ) : (
        <ul className="mt-5 divide-y divide-slate-100">
          {roster.entries.map((entry) => (
            <li key={entry.attendeeId} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-slate-900">{entry.name}</p>
                {entry.fundingLabel ? <p className="mt-0.5 text-xs text-slate-500">{entry.fundingLabel}</p> : null}
              </div>
              <div className="flex items-center gap-3">
                <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${chipClass(entry)}`}>{chipLabel(entry)}</span>
                {canManage && entry.canRemove ? (
                  <RemoveControl entry={entry} appointmentId={appointmentId} returnTo={returnTo} />
                ) : canManage && entry.hasTerminalAttendance ? (
                  <span className="max-w-[10rem] text-right text-xs text-slate-500">Attendance recorded</span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      {roster.removed.length > 0 ? (
        <details className="mt-4 text-sm">
          <summary className="cursor-pointer text-xs font-medium text-slate-600">Removed ({roster.removed.length})</summary>
          <ul className="mt-2 space-y-1 text-xs text-slate-500">
            {roster.removed.map((entry) => (
              <li key={entry.attendeeId}>{entry.name}</li>
            ))}
          </ul>
        </details>
      ) : null}

      {canManage ? (
        <div className="mt-5 space-y-3">
          {closedReason === "cancelled" ? (
            <p className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
              This class is cancelled, so its roster is closed.
            </p>
          ) : closedReason === "ended" ? (
            <p className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
              This class has ended, so enrollment is closed. Attendance can still be recorded.
            </p>
          ) : (
            <AddDancerPanel appointmentId={appointmentId} returnTo={returnTo} isBroadStaff={isBroadStaff} full={full} defaultOpen={reopenAdd} />
          )}
        </div>
      ) : null}
    </section>
  );
}
