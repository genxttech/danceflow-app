"use client";

import Image from "next/image";
import Link from "next/link";
import { LogOut, Menu, X } from "lucide-react";
import { useEffect, useRef, type RefObject } from "react";
import NotificationMenu from "@/components/ui/NotificationMenu";
import WorkspaceSwitcher from "./WorkspaceSwitcher";
import { DesktopNavSection, MobileNavSection } from "./SidebarNavSection";
import { prettyRole } from "./navUtils";
import type { NavSectionType, NotificationItem, WorkspaceItem } from "./types";

export const MOBILE_DRAWER_ID = "app-mobile-navigation";

const focusRing =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-primary)]";

/**
 * Focus loop for the modal drawer: which focusable index Tab / Shift+Tab should move to.
 * `current` is the index of the focused element (-1 when focus is outside the list).
 * Returns -1 when there is nothing to focus.
 */
export function nextFocusIndex(
  current: number,
  count: number,
  shiftKey: boolean,
): number {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return shiftKey ? count - 1 : 0;
  return shiftKey ? (current - 1 + count) % count : (current + 1) % count;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function getFocusable(container: HTMLElement | null) {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hidden && element.getClientRects().length > 0,
  );
}

export function MobileTopBar({
  studioName,
  userName,
  unreadNotificationsCount,
  notifications,
  open,
  menuButtonRef,
  onOpen,
}: {
  studioName: string;
  userName: string;
  unreadNotificationsCount: number;
  notifications: NotificationItem[];
  open: boolean;
  menuButtonRef: RefObject<HTMLButtonElement | null>;
  onOpen: () => void;
}) {
  return (
    <div className="border-b border-[var(--brand-border)] bg-white px-4 py-3 lg:hidden">
      <div className="flex items-center justify-between gap-3">
        <button
          ref={menuButtonRef}
          type="button"
          onClick={onOpen}
          className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[var(--brand-border)] text-[var(--brand-primary)] hover:bg-[var(--brand-primary-soft)] ${focusRing}`}
          aria-label="Open navigation"
          aria-expanded={open}
          aria-controls={MOBILE_DRAWER_ID}
        >
          <Menu aria-hidden="true" className="h-5 w-5" />
        </button>

        <Image
          src="/brand/logo/danceflow-symbol-128.png"
          alt="DanceFlow"
          width={128}
          height={177}
          className="h-7 w-auto shrink-0"
        />

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
    <aside
      aria-label="Workspace sidebar"
      className="hidden lg:sticky lg:top-0 lg:block lg:h-screen"
    >
      <div className="brand-sidebar flex h-full flex-col border-r border-white/10">
        <div className="border-b border-white/10 px-5 py-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <Link
                href="/app"
                className="inline-block rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
              >
                <Image
                  src="/brand/logo/danceflow-logo-primary-white.png"
                  alt="DanceFlow"
                  width={1200}
                  height={300}
                  sizes="180px"
                  className="h-auto w-[180px]"
                  priority
                />
              </Link>

              <div className="mt-4 min-w-0">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/70">
                  Workspace
                </p>
                <p className="mt-1 truncate text-lg font-semibold text-white">
                  {studioName}
                </p>
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

            <nav aria-label="Workspace" className="space-y-6">
              {sections.map((section) => (
                <DesktopNavSection
                  key={section.title}
                  title={section.title}
                  items={section.items}
                  pathname={pathname}
                />
              ))}
            </nav>
          </div>

          <div className="mt-10 rounded-2xl border border-white/10 bg-white/6 p-4 backdrop-blur">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/70">
              Signed in as
            </p>
            <p className="mt-2 font-medium text-white">{userName}</p>
            <p className="text-sm text-white/75">{userEmail}</p>
            <p className="mt-2 text-xs text-[var(--brand-accent-soft)]">{prettyRole(role)}</p>
          </div>
        </div>

        <div className="border-t border-white/10 px-5 py-4">
          <form action="/auth/logout" method="post">
            <button className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/8 px-4 py-2 text-white hover:bg-white/12 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white">
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
  const panelRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // Modal dialog: move focus inside, then keep Tab / Shift+Tab looping within the panel.
    closeButtonRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }

      if (event.key !== "Tab") return;

      const focusable = getFocusable(panelRef.current);
      const target = nextFocusIndex(
        focusable.indexOf(document.activeElement as HTMLElement),
        focusable.length,
        event.shiftKey,
      );

      event.preventDefault();
      if (target >= 0) focusable[target].focus();
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div id={MOBILE_DRAWER_ID} className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
      <button
        type="button"
        onClick={onClose}
        className="absolute inset-0 bg-slate-900/45"
        aria-label="Close navigation"
        tabIndex={-1}
      />

      <div ref={panelRef} className="absolute inset-y-0 left-0 w-[min(92vw,24rem)] bg-[var(--brand-surface)] shadow-xl">
        <div className="flex h-full flex-col">
          <div className="border-b border-[var(--brand-border)] bg-white px-5 py-5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <Image
                  src="/brand/logo/danceflow-logo-primary-320.png"
                  alt="DanceFlow"
                  width={320}
                  height={80}
                  sizes="150px"
                  className="h-auto w-[150px]"
                />

                <div className="mt-4 min-w-0">
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--brand-muted)]">
                    Workspace
                  </p>
                  <p className="mt-1 truncate text-lg font-semibold text-[var(--brand-text)]">
                    {studioName}
                  </p>
                </div>
              </div>

              <button
                ref={closeButtonRef}
                type="button"
                onClick={onClose}
                className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[var(--brand-border)] text-[var(--brand-primary)] hover:bg-[var(--brand-primary-soft)] ${focusRing}`}
                aria-label="Close navigation"
              >
                <X aria-hidden="true" className="h-5 w-5" />
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

              <nav aria-label="Workspace" className="space-y-6">
                {sections.map((section) => (
                  <MobileNavSection
                    key={section.title}
                    title={section.title}
                    items={section.items}
                    pathname={pathname}
                    onNavigate={onClose}
                  />
                ))}
              </nav>
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
              <button className={`brand-button-primary flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2 ${focusRing}`}>
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
