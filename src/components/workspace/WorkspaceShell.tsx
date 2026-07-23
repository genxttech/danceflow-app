import type { ReactNode } from "react";
import { classNames } from "./classNames";

export default function WorkspaceShell({
  header,
  toolbar,
  summary,
  list,
  detail,
  context,
  children,
  className,
}: {
  header?: ReactNode;
  toolbar?: ReactNode;
  summary?: ReactNode;
  list?: ReactNode;
  detail?: ReactNode;
  context?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const hasPaneLayout = Boolean(list || detail || context);

  return (
    <div
      className={classNames(
        "min-h-[calc(100vh-4rem)] bg-[var(--brand-surface)]",
        className,
      )}
    >
      {header ? <div className="border-b border-[var(--brand-border)] bg-white">{header}</div> : null}
      {toolbar ? <div className="border-b border-[var(--brand-border)] bg-white">{toolbar}</div> : null}
      {summary ? <div className="border-b border-[var(--brand-border)] bg-white">{summary}</div> : null}

      {hasPaneLayout ? (
        <div className="grid min-h-0 lg:grid-cols-[minmax(17rem,22rem)_minmax(0,1fr)] 2xl:grid-cols-[minmax(17rem,22rem)_minmax(0,1fr)_minmax(18rem,22rem)]">
          {list ? (
            <aside className="min-h-0 border-b border-[var(--brand-border)] bg-white lg:border-b-0 lg:border-r">
              {list}
            </aside>
          ) : null}

          <section className="min-h-0 min-w-0 bg-[var(--brand-surface)]">
            {detail ?? children}
          </section>

          {context ? (
            <aside className="hidden min-h-0 border-l border-[var(--brand-border)] bg-white 2xl:block">
              {context}
            </aside>
          ) : null}
        </div>
      ) : (
        <div className="min-w-0">{children}</div>
      )}
    </div>
  );
}
