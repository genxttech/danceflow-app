import type { ReactNode } from "react";
import PublicShell from "@/components/public/PublicShell";

export default function MarketplaceLayout({
  children,
}: {
  children: ReactNode;
}) {
  return <PublicShell>{children}</PublicShell>;
}
