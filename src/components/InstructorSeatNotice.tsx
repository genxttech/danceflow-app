import Link from "next/link";
import {
  describeInstructorSeatNotice,
  type InstructorSeatStatus,
} from "@/lib/instructors/seatStatus";

/**
 * Landmark 1A Slice 8 -- the single over-limit notice. Renders nothing unless
 * derived usage exceeds the effective limit. One notice, two actions.
 */
export function InstructorSeatNotice({
  status,
  showManageLink = true,
}: {
  status: InstructorSeatStatus | null;
  showManageLink?: boolean;
}) {
  const copy = describeInstructorSeatNotice(status);
  if (!copy) return null;

  return (
    <div
      role="status"
      className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-amber-950"
    >
      <p className="text-sm font-semibold">{copy.title}</p>
      <p className="mt-1 text-sm leading-6 text-amber-900">{copy.body}</p>
      <div className="mt-3 flex flex-wrap gap-3">
        {showManageLink ? (
          <Link
            href="/app/instructors"
            className="rounded-xl bg-amber-900 px-3 py-2 text-sm font-semibold text-white hover:bg-amber-800"
          >
            Manage instructors
          </Link>
        ) : null}
        <Link
          href="/app/settings/billing"
          className="rounded-xl border border-amber-300 bg-white px-3 py-2 text-sm font-semibold text-amber-900 hover:bg-amber-100"
        >
          {copy.kind === "inactive_subscription" ? "Update billing" : "Upgrade plan"}
        </Link>
      </div>
    </div>
  );
}
