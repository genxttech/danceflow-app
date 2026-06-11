"use client";

import { useState } from "react";
import { Building2, Check, ChevronsUpDown } from "lucide-react";
import type { WorkspaceItem } from "./types";
import { prettyRole } from "./navUtils";

export default function WorkspaceSwitcher({
  workspaces,
  currentStudioId,
  switchWorkspaceAction,
  mobile = false,
}: {
  workspaces: WorkspaceItem[];
  currentStudioId?: string;
  switchWorkspaceAction: (formData: FormData) => void | Promise<void>;
  mobile?: boolean;
}) {
  const [open, setOpen] = useState(false);

  if (!workspaces.length) return null;

  const currentWorkspace =
    workspaces.find((workspace) => workspace.studioId === currentStudioId) ??
    workspaces.find((workspace) => workspace.isSelected) ??
    workspaces[0];

  const wrapperClass = mobile
    ? "rounded-2xl border border-[var(--brand-border)] bg-white p-4"
    : "rounded-2xl border border-white/10 bg-white/6 p-4 backdrop-blur";

  const labelClass = mobile ? "text-[var(--brand-muted)]" : "text-white/50";
  const titleClass = mobile ? "text-[var(--brand-text)]" : "text-white";
  const subtitleClass = mobile
    ? "text-[var(--brand-accent-dark)]"
    : "text-[#FFDCA9]";
  const buttonClass = mobile
    ? "border-[var(--brand-border)] bg-white text-[var(--brand-text)] hover:bg-[var(--brand-primary-soft)]"
    : "border-white/10 bg-white/8 text-white hover:bg-white/12";

  const dropdownClass = mobile
    ? "border-[var(--brand-border)] bg-white shadow-xl"
    : "border-white/10 bg-[#111b45] shadow-2xl";

  const itemClass = mobile
    ? "hover:bg-[var(--brand-primary-soft)] text-[var(--brand-text)]"
    : "hover:bg-white/8 text-white";

  const roleClass = mobile
    ? "text-[var(--brand-accent-dark)]"
    : "text-[#FFDCA9]";

  return (
    <div className={wrapperClass}>
      <p
        className={`text-xs font-semibold uppercase tracking-[0.18em] ${labelClass}`}
      >
        Workspace
      </p>

      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={`mt-3 flex w-full items-center justify-between rounded-xl border px-3 py-3 text-left transition ${buttonClass}`}
      >
        <div className="min-w-0">
          <p className={`truncate font-medium ${titleClass}`}>
            {currentWorkspace.studioPublicName?.trim() ||
              currentWorkspace.studioName}
          </p>
          <p className={`mt-1 truncate text-xs ${subtitleClass}`}>
            {prettyRole(currentWorkspace.studioRole)}
          </p>
        </div>

        <ChevronsUpDown className="h-4 w-4 shrink-0" />
      </button>

      {open ? (
        <div
          className={`mt-3 overflow-hidden rounded-2xl border ${dropdownClass}`}
        >
          <div className="max-h-72 overflow-y-auto p-2">
            {workspaces.map((workspace) => {
              const active = workspace.studioId === currentWorkspace.studioId;

              return (
                <form
                  key={workspace.studioId}
                  action={async (formData) => {
                    await switchWorkspaceAction(formData);
                    setOpen(false);
                  }}
                >
                  <input
                    type="hidden"
                    name="studioId"
                    value={workspace.studioId}
                  />
                  <button
                    type="submit"
                    className={`flex w-full items-center justify-between rounded-xl px-3 py-3 text-left transition ${itemClass}`}
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">
                        {workspace.studioPublicName?.trim() ||
                          workspace.studioName}
                      </p>
                      <p className={`mt-1 truncate text-xs ${roleClass}`}>
                        {prettyRole(workspace.studioRole)}
                      </p>
                    </div>

                    {active ? (
                      <Check className="h-4 w-4 shrink-0" />
                    ) : (
                      <Building2 className="h-4 w-4 shrink-0 opacity-60" />
                    )}
                  </button>
                </form>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
