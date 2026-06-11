"use client";

import Image from "next/image";
import { LogOut, Menu, X } from "lucide-react";
import NotificationMenu from "@/components/ui/NotificationMenu";
import WorkspaceSwitcher from "./WorkspaceSwitcher";
import { DesktopNavSection, MobileNavSection } from "./SidebarNavSection";
import { prettyRole } from "./navUtils";
import type { NavSectionType, NotificationItem, WorkspaceItem } from "./types";

export function MobileTopBar({
  studioName,
  userName,
  unreadNotificationsCount,
  notifications,
  onOpen,
}: {
  studioName: string;
  userName: string;
  unreadNotificationsCount: number;
  notifications: NotificationItem[];
  onOpen: () => void;
}) {
  return (
    <div className="border-b border-[var(--brand-border)] bg-white px-4 py-3 lg:hidden">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onOpen}
          className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-[var(--brand-border)] text-[var(--brand-primary)] hover:bg-[var(--brand-primary-soft)]"
          aria-label="Open navigation"
        >
          <Menu className="h-5 w-5" />
        </button>

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-[var(--brand-text)]">
            {studioName}
          </p>
          <p className="truncate text-xs text-[var(--brand-muted)]">
            {userName}
          </p>
        </div>

        <NotificationMenu
          unreadCount={unreadNotificationsCount}
          notifications={notifications}
        />
      </div>
    </div>
  );
}

export function DesktopSidebar({
  studioName,
  userName,
  userEmail,
  role,
  pathname,
  unreadNotificationsCount,
  notifications,
  sections,
  workspaces,
  currentStudioId,
  switchWorkspaceAction,
}: {
  studioName: string;
  userName: string;
  userEmail: string;
  role: string;
  pathname: string;
  unreadNotificationsCount: number;
  notifications: NotificationItem[];
  sections: NavSectionType[];
  workspaces: WorkspaceItem[];
  currentStudioId?: string;
  switchWorkspaceAction: (formData: FormData) => void | Promise<void>;
}) {
  return (
    <aside className="hidden lg:sticky lg:top-0 lg:block lg:h-screen">
      <div className="brand-sidebar flex h-full flex-col border-r border-white/10">
        <div className="border-b border-white/10 px-5 py-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-3">
                <div className="relative h-16 w-16 overflow-hidden rounded-2xl bg-white/8 p-1 ring-1 ring-white/10">
                  <Image
                    src="/brand/danceflow-logo.png"
                    alt="DanceFlow logo"
                    fill
                    sizes="64px"
                    className="object-contain"
                  />
                </div>

                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/50">
                    Workspace
                  </p>
                  <h1 className="mt-1 truncate text-2xl font-semibold text-white">
                    {studioName}
                  </h1>
                  <p className="mt-1 text-sm text-[#FFDCA9]">DanceFlow</p>
                </div>
              </div>
            </div>

            <NotificationMenu
              unreadCount={unreadNotificationsCount}
              notifications={notifications}
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-5">
          <div className="space-y-6">
            {workspaces.length > 1 ? (
              <WorkspaceSwitcher
                workspaces={workspaces}
                currentStudioId={currentStudioId}
                switchWorkspaceAction={switchWorkspaceAction}
              />
            ) : null}

            {sections.map((section) => (
              <DesktopNavSection
                key={section.title}
                title={section.title}
                items={section.items}
                pathname={pathname}
              />
            ))}
          </div>

          <div className="mt-10 rounded-2xl border border-white/10 bg-white/6 p-4 backdrop-blur">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/50">
              Signed in as
            </p>
            <p className="mt-2 font-medium text-white">{userName}</p>
            <p className="text-sm text-white/75">{userEmail}</p>
            <p className="mt-2 text-xs text-[#FFDCA9]">{prettyRole(role)}</p>
          </div>
        </div>

        <div className="border-t border-white/10 px-5 py-4">
          <form action="/auth/logout" method="post">
            <button className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/8 px-4 py-2 text-white hover:bg-white/12">
              <LogOut className="h-4 w-4" />
              <span>Log Out</span>
            </button>
          </form>
        </div>
      </div>
    </aside>
  );
}

export function MobileSidebar({
  open,
  studioName,
  userName,
  userEmail,
  role,
  pathname,
  sections,
  workspaces,
  currentStudioId,
  switchWorkspaceAction,
  onClose,
}: {
  open: boolean;
  studioName: string;
  userName: string;
  userEmail: string;
  role: string;
  pathname: string;
  sections: NavSectionType[];
  workspaces: WorkspaceItem[];
  currentStudioId?: string;
  switchWorkspaceAction: (formData: FormData) => void | Promise<void>;
  onClose: () => void;
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 lg:hidden">
      <button
        type="button"
        onClick={onClose}
        className="absolute inset-0 bg-slate-900/45"
        aria-label="Close navigation backdrop"
      />

      <div className="absolute inset-y-0 left-0 w-full max-w-sm bg-[var(--brand-surface)] shadow-xl">
        <div className="flex h-full flex-col">
          <div className="border-b border-[var(--brand-border)] bg-white px-5 py-5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-4">
                  <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-2xl border border-[var(--brand-border)] bg-white p-2 shadow-sm">
                    <Image
                      src="/brand/danceflow-logo.png"
                      alt="DanceFlow logo"
                      fill
                      sizes="80px"
                      className="object-contain p-1"
                    />
                  </div>

                  <div className="min-w-0">
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--brand-muted)]">
                      Workspace
                    </p>
                    <h2 className="mt-1 truncate text-2xl font-semibold text-[var(--brand-text)]">
                      {studioName}
                    </h2>
                    <p className="mt-1 text-base font-medium text-[var(--brand-accent-dark)]">
                      DanceFlow
                    </p>
                  </div>
                </div>
              </div>

              <button
                type="button"
                onClick={onClose}
                className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-[var(--brand-border)] text-[var(--brand-primary)] hover:bg-[var(--brand-primary-soft)]"
                aria-label="Close navigation"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-5">
            <div className="space-y-6">
              {workspaces.length > 1 ? (
                <WorkspaceSwitcher
                  workspaces={workspaces}
                  currentStudioId={currentStudioId}
                  switchWorkspaceAction={switchWorkspaceAction}
                  mobile
                />
              ) : null}

              {sections.map((section) => (
                <MobileNavSection
                  key={section.title}
                  title={section.title}
                  items={section.items}
                  pathname={pathname}
                  onNavigate={onClose}
                />
              ))}
            </div>

            <div className="mt-8 rounded-2xl border border-[var(--brand-border)] bg-white p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--brand-muted)]">
                Signed in as
              </p>
              <p className="mt-2 font-medium text-[var(--brand-text)]">
                {userName}
              </p>
              <p className="text-sm text-[var(--brand-muted)]">{userEmail}</p>
              <p className="mt-2 text-xs text-[var(--brand-accent-dark)]">
                {prettyRole(role)}
              </p>
            </div>
          </div>

          <div className="border-t border-[var(--brand-border)] bg-white px-5 py-4">
            <form action="/auth/logout" method="post">
              <button className="brand-button-primary flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2">
                <LogOut className="h-4 w-4" />
                <span>Log Out</span>
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
