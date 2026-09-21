import type { ReactNode } from "react";
import PublicShell from "@/components/public/PublicShell";

export default function KnowledgebaseLayout({
  children: page,
}: {
  children: ReactNode;
}) {
  // Semantic main landmark only: no classes, so page body geometry is unchanged.
  const children = <main>{page}</main>;

  return <PublicShell>{children}</PublicShell>;
}
