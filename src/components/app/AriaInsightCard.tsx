import Link from "next/link";
import AriaAvatar from "./AriaAvatar";

type AriaAction = {
  href: string;
  label: string;
};

type AriaInsightCardProps = {
  eyebrow?: string;
  title: string;
  insight: string;
  recommendation?: string;
  metric?: string;
  primaryAction?: AriaAction;
  secondaryAction?: AriaAction;
  compact?: boolean;
  className?: string;
};

export default function AriaInsightCard({
  eyebrow = "ARIA Insight",
  title,
  insight,
  recommendation,
  metric,
  primaryAction,
  secondaryAction,
  compact = false,
  className = "",
}: AriaInsightCardProps) {
  return (
    <section
      className={`overflow-hidden rounded-[32px] border border-[#F9A8D4] bg-white shadow-sm ${className}`}
    >
      <div className="relative p-5 md:p-6">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(236,72,153,0.16),transparent_34%),linear-gradient(135deg,rgba(255,247,237,0.85),rgba(255,255,255,0.95)_42%,rgba(250,245,255,0.9))]" />
        <div className="relative flex flex-col gap-4 sm:flex-row sm:items-start">
          <AriaAvatar size={compact ? "sm" : "md"} className="shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex rounded-full bg-[#FCE7F3] px-3 py-1 text-[11px] font-bold uppercase tracking-[0.18em] text-[#BE185D] ring-1 ring-[#F9A8D4]">
                {eyebrow}
              </span>
              {metric ? (
                <span className="inline-flex rounded-full bg-white/80 px-3 py-1 text-xs font-semibold text-[#7C2D12] ring-1 ring-orange-200">
                  {metric}
                </span>
              ) : null}
            </div>

            <h2 className={`${compact ? "mt-2 text-lg" : "mt-3 text-xl md:text-2xl"} font-semibold tracking-tight text-slate-950`}>
              {title}
            </h2>
            <p className="mt-2 text-sm leading-6 text-slate-700">{insight}</p>
            {recommendation ? (
              <p className="mt-3 rounded-2xl border border-[#FBCFE8] bg-white/75 px-4 py-3 text-sm leading-6 text-slate-700">
                <span className="font-semibold text-[#BE185D]">Recommended next move:</span>{" "}
                {recommendation}
              </p>
            ) : null}

            {primaryAction || secondaryAction ? (
              <div className="mt-4 flex flex-wrap gap-2">
                {primaryAction ? (
                  <Link
                    href={primaryAction.href}
                    className="inline-flex items-center justify-center rounded-xl bg-[#BE185D] px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-[#9D174D]"
                  >
                    {primaryAction.label}
                  </Link>
                ) : null}
                {secondaryAction ? (
                  <Link
                    href={secondaryAction.href}
                    className="inline-flex items-center justify-center rounded-xl border border-[#F9A8D4] bg-white px-4 py-2 text-sm font-semibold text-[#BE185D] hover:bg-[#FDF2F8]"
                  >
                    {secondaryAction.label}
                  </Link>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
