import type { ReactNode } from "react";
import DiscoverSubNav from "@/components/public/DiscoverSubNav";
import PublicShell from "@/components/public/PublicShell";

export default function DiscoverLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <PublicShell>
      <DiscoverSubNav />
      {children}
    </PublicShell>
  );
}
