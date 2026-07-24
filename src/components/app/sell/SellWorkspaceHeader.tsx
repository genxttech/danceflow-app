import type { ReactNode } from "react";
import WorkspaceHeader from "@/components/app/workspace/WorkspaceHeader";
import SellWorkspaceNav from "./SellWorkspaceNav";

export default function SellWorkspaceHeader({
  role,
  isPlatformAdmin = false,
  eyebrow = "Sell workspace",
  title,
  description,
  actions,
}: {
  role: string | null | undefined;
  isPlatformAdmin?: boolean;
  eyebrow?: string;
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-[28px] border border-[var(--brand-border)] bg-white shadow-sm">
      <WorkspaceHeader
        eyebrow={eyebrow}
        title={title}
        description={description}
        actions={actions}
        className="bg-[linear-gradient(135deg,rgba(69,38,116,0.08)_0%,rgba(255,247,237,0.72)_100%)]"
      />
      <SellWorkspaceNav role={role} isPlatformAdmin={isPlatformAdmin} />
    </section>
  );
}
