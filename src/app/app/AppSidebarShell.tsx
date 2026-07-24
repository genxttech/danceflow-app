"use client";

import { usePathname } from "next/navigation";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  DesktopSidebar,
  MobileSidebar,
  MobileTopBar,
} from "@/components/app/sidebar/AppShellChrome";
import { normalizeSections } from "@/components/app/sidebar/navUtils";
import type {
  NotificationItem,
  WorkspaceItem,
} from "@/components/app/sidebar/types";

export default function AppSidebarShell({
  pathname,
  studioName,
  userName,
  userEmail,
  role,
  navigationRole,
  sections,
  unreadNotificationsCount = 0,
  recentNotifications = [],
  workspaces = [],
  currentStudioId,
  switchWorkspaceAction,
  hasOrganizerSuite = false,
  children,
}: {
  pathname?: string;
  studioName?: string;
  userName?: string;
  userEmail?: string;
  role?: string;
  navigationRole?: string | null;
  sections?: unknown;
  unreadNotificationsCount?: number;
  recentNotifications?: NotificationItem[];
  workspaces?: WorkspaceItem[];
  currentStudioId?: string;
  switchWorkspaceAction: (formData: FormData) => void | Promise<void>;
  hasOrganizerSuite?: boolean;
  children: ReactNode;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const currentPathname = usePathname();

  const safePathname = currentPathname || pathname || "/app";
  const safeStudioName = studioName || "Workspace";
  const safeUserName = userName || "Unknown User";
  const safeUserEmail = userEmail || "";
  const safeRole = role || "";
  const safeNotifications = Array.isArray(recentNotifications)
    ? recentNotifications
    : [];

  const normalizedSections = useMemo(
    () => normalizeSections(sections, { hasOrganizerSuite, role: navigationRole }),
    [sections, hasOrganizerSuite, navigationRole],
  );

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[320px_minmax(0,1fr)]">
      <MobileTopBar
        studioName={safeStudioName}
        userName={safeUserName}
        unreadNotificationsCount={unreadNotificationsCount}
        notifications={safeNotifications}
        onOpen={() => setMobileOpen(true)}
      />

      <DesktopSidebar
        studioName={safeStudioName}
        userName={safeUserName}
        userEmail={safeUserEmail}
        role={safeRole}
        pathname={safePathname}
        unreadNotificationsCount={unreadNotificationsCount}
        notifications={safeNotifications}
        sections={normalizedSections}
        workspaces={workspaces}
        currentStudioId={currentStudioId}
        switchWorkspaceAction={switchWorkspaceAction}
      />

      <main className="min-w-0">{children}</main>

      <MobileSidebar
        open={mobileOpen}
        studioName={safeStudioName}
        userName={safeUserName}
        userEmail={safeUserEmail}
        role={safeRole}
        pathname={safePathname}
        sections={normalizedSections}
        workspaces={workspaces}
        currentStudioId={currentStudioId}
        switchWorkspaceAction={switchWorkspaceAction}
        onClose={() => setMobileOpen(false)}
      />
    </div>
  );
}
