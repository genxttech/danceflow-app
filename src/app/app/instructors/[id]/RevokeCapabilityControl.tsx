import { revokeInstructorCapabilityAction } from "../actions";

/**
 * Landmark 1A Slice 7 -- "Remove instructional capability" control for the
 * instructor detail page. Rendered only for a currently capable instructor
 * and only for actors who can manage instructors (the RPC re-authorizes
 * regardless). The confirmation is a native <details> disclosure, so it
 * works without client JS: nothing is submitted until the actor opens it
 * and presses the explicit confirm button.
 */
export function RevokeCapabilityControl({
  instructorId,
  canInstruct,
  canManage,
}: {
  instructorId: string;
  canInstruct: boolean;
  canManage: boolean;
}) {
  if (!canInstruct || !canManage) return null;

  return (
    <details className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3">
      <summary className="cursor-pointer text-sm font-semibold text-slate-700">
        Remove instructional capability
      </summary>
      <form action={revokeInstructorCapabilityAction} className="mt-3 space-y-3">
        <input type="hidden" name="instructorId" value={instructorId} />
        <ul className="list-disc space-y-1 pl-5 text-sm text-slate-600">
          <li>
            Any future instructional work assigned to this instructor (upcoming
            lessons and classes, and pending booking or self-service requests)
            must be reassigned, cancelled, or resolved first.
          </li>
          <li>
            Removing capability frees this instructor&apos;s instructional seat
            immediately.
          </li>
          <li>
            Past and historical work stays on record. The account, active
            status, and payroll and rental relationships are not changed.
          </li>
        </ul>
        <button
          type="submit"
          className="rounded-xl border border-red-200 bg-white px-3 py-2 text-sm font-semibold text-red-700 hover:bg-red-50"
        >
          Confirm: remove instructional capability
        </button>
      </form>
    </details>
  );
}
