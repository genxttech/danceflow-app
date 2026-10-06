import Link from "next/link";
import {
  availabilityCopy,
  formatClassWhen,
  publicClassPath,
  type AvailabilityTone,
  type PublicGroupClass,
} from "@/lib/public/groupClasses";

const toneClass: Record<AvailabilityTone, string> = {
  good: "bg-emerald-50 text-emerald-800",
  limited: "bg-amber-50 text-amber-900",
  full: "bg-rose-50 text-rose-800",
  closed: "bg-slate-100 text-slate-700",
};

export function AvailabilityBadge({ item }: { item: Pick<PublicGroupClass, "publicState" | "availability" | "spotsRemaining"> }) {
  const { label, tone } = availabilityCopy(item);
  return <span className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${toneClass[tone]}`}>{label}</span>;
}

/**
 * One simple public class card: what, when, where, who, availability, and one primary action. No chips, no funding or policy
 * labels, no sign-in prompt. The whole card is the single link target.
 */
export default function PublicClassCard({ item, showStudio = true }: { item: PublicGroupClass; showStudio?: boolean }) {
  const when = formatClassWhen(item.startsAt, item.endsAt, item.timeZone);
  const details = [showStudio ? item.studioName : null, item.locationLabel, item.instructorName ? `with ${item.instructorName}` : null].filter(Boolean);

  return (
    <article className="flex h-full flex-col rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-lg font-semibold tracking-tight text-slate-950">{item.title}</h3>
        <AvailabilityBadge item={item} />
      </div>
      <p className="mt-2 text-sm font-medium text-slate-800">{when}</p>
      {details.length > 0 ? <p className="mt-1 text-sm text-slate-600">{details.join(" · ")}</p> : null}
      <Link
        href={publicClassPath(item.studioSlug, item.appointmentId)}
        className="mt-5 inline-flex items-center justify-center rounded-2xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white hover:bg-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-950 sm:self-start"
      >
        View class
        <span className="sr-only">: {item.title}, {when}</span>
      </Link>
    </article>
  );
}
