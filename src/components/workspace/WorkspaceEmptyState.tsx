import type { ReactNode } from "react";

export default function WorkspaceEmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-[18rem] items-center justify-center p-6">
      <div className="max-w-md text-center">
        {icon ? (
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--brand-primary-soft)] text-[var(--brand-primary)]">
            {icon}
          </div>
        ) : null}
        <h2 className="mt-4 text-lg font-semibold text-[var(--brand-text)]">{title}</h2>
        {description ? (
          <p className="mt-2 text-sm leading-6 text-[var(--brand-muted)]">{description}</p>
        ) : null}
        {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
      </div>
    </div>
  );
}
