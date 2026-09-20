import type { ReactNode } from "react";
import { getPublicAuthState } from "@/lib/public/authState";
import PublicSiteFooter from "./PublicSiteFooter";
import PublicSiteHeader from "./PublicSiteHeader";
import type { PublicNavPath } from "./publicNav";

type PublicShellProps = {
  children: ReactNode;
  currentPath?: PublicNavPath;
  /**
   * Trusted override for pages that already know the answer (for example pages that
   * redirect signed-out visitors before rendering). When omitted the shell resolves it.
   */
  isAuthenticated?: boolean;
  footer?: boolean;
};

/**
 * Canonical public chrome: header, page content, footer.
 * Deliberately imposes no width, padding or body layout; pages keep their own.
 */
export default async function PublicShell({
  children,
  currentPath,
  isAuthenticated,
  footer = true,
}: PublicShellProps) {
  const signedIn = isAuthenticated ?? (await getPublicAuthState());

  return (
    <>
      <PublicSiteHeader currentPath={currentPath} isAuthenticated={signedIn} />
      {children}
      {footer ? <PublicSiteFooter /> : null}
    </>
  );
}
