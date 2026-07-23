import type { ReactNode } from "react";
import { classNames } from "./classNames";

export default function WorkspacePane({
  title,
  description,
  actions,
  children,
  scroll = true,
  className,
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  scroll?: boolean;
  className?: string;
}) {
  return (
    <div className={classNames("flex min-h-0 flex-col", className)}>
      {title || description || actions ? (
        <div className="flex items-start justify-between gap-3 border-b border-[var(--brand-border)] px-4 py-3">
          <div className="min-w-0">
            {title ? (
              <h2 className="truncate text-sm font-semibold text-[var(--brand-text)]">{title}</h2>
            ) : null}
            {description ? (
              <p className="mt-0.5 text-xs leading-5 text-[var(--brand-muted)]">{description}</p>
            ) : null}
          </div>
          {actions ? <div className="shrink-0">{actions}</div> : null}
        </div>
      ) : null}
      <div className={classNames("min-h-0 flex-1", scroll && "overflow-y-auto")}>{children}</div>
    </div>
  );
}
