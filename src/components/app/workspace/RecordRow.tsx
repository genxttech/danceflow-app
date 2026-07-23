import type { ReactNode } from "react";
import { classNames } from "./classNames";

export default function RecordRow({
  title,
  subtitle,
  leading,
  meta,
  trailing,
  selected = false,
  onClick,
  href,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  leading?: ReactNode;
  meta?: ReactNode;
  trailing?: ReactNode;
  selected?: boolean;
  onClick?: () => void;
  href?: string;
  className?: string;
}) {
  const content = (
    <>
      {leading ? <div className="shrink-0">{leading}</div> : null}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold text-[var(--brand-text)]">{title}</div>
        {subtitle ? (
          <div className="mt-0.5 truncate text-xs text-[var(--brand-muted)]">{subtitle}</div>
        ) : null}
        {meta ? <div className="mt-1 flex flex-wrap gap-1.5">{meta}</div> : null}
      </div>
      {trailing ? <div className="shrink-0">{trailing}</div> : null}
    </>
  );

  const classes = classNames(
    "flex w-full items-start gap-3 border-b border-[var(--brand-border)] px-4 py-3 text-left transition",
    selected
      ? "bg-[var(--brand-primary-soft)] shadow-[inset_3px_0_0_var(--brand-primary)]"
      : "bg-white hover:bg-[var(--brand-primary-soft)]/55",
    className,
  );

  if (href) {
    return (
      <a href={href} className={classes} aria-current={selected ? "page" : undefined}>
        {content}
      </a>
    );
  }

  return (
    <button type="button" onClick={onClick} className={classes} aria-pressed={selected}>
      {content}
    </button>
  );
}
