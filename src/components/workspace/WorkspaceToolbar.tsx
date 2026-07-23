import type { ReactNode } from "react";
import { classNames } from "./classNames";

export default function WorkspaceToolbar({
  primary,
  filters,
  actions,
  className,
}: {
  primary?: ReactNode;
  filters?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={classNames(
        "flex flex-col gap-3 px-4 py-3 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8",
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-3 lg:flex-row lg:items-center">
        {primary ? <div className="min-w-0 lg:max-w-md lg:flex-1">{primary}</div> : null}
        {filters ? <div className="flex flex-wrap items-center gap-2">{filters}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
