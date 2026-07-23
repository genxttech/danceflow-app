import type { ReactNode } from "react";
import { classNames } from "./classNames";

export default function StickyActionBar({
  primary,
  secondary,
  className,
}: {
  primary: ReactNode;
  secondary?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={classNames(
        "sticky bottom-0 z-20 flex items-center justify-end gap-2 border-t border-[var(--brand-border)] bg-white/95 px-4 py-3 shadow-[0_-8px_24px_rgba(15,23,42,0.06)] backdrop-blur",
        className,
      )}
    >
      {secondary}
      {primary}
    </div>
  );
}
