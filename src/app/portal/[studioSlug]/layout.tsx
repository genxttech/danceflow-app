import type { ReactNode } from "react";

type PortalStudioLayoutProps = {
  children: ReactNode;
};

export default function PortalStudioLayout({
  children,
}: PortalStudioLayoutProps) {
  return <>{children}</>;
}