"use client";

import { useActionState, useState } from "react";
import {
  archiveClientPackageAction,
  reactivateClientPackageAction,
} from "./actions";

const initialState = { error: "" };

export default function PackageArchiveControls({
  clientId,
  clientPackageId,
  isArchived,
  canReactivate,
}: {
  clientId: string;
  clientPackageId: string;
  isArchived: boolean;
  canReactivate: boolean;
}) {
  const [archiveState, archiveFormAction, archivePending] = useActionState(
    archiveClientPackageAction,
    initialState,
  );
  const [reactivateState, reactivateFormAction, reactivatePending] = useActionState(
    reactivateClientPackageAction,
    initialState,
  );
  const [showReasonField, setShowReasonField] = useState(false);

  if (isArchived) {
    return (
      <div className="flex flex-col items-end gap-1">
        <form action={reactivateFormAction}>
          <input type="hidden" name="clientId" value={clientId} />
          <input type="hidden" name="clientPackageId" value={clientPackageId} />
          <button
            type="submit"
            disabled={!canReactivate || reactivatePending}
            title={
              canReactivate
                ? undefined
                : "This package has no remaining balance or is expired, so it cannot be reactivated."
            }
            className="whitespace-nowrap rounded-full border border-[var(--brand-border)] px-3 py-1 text-xs font-medium text-[var(--brand-text)] hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {reactivatePending ? "Reactivating..." : "Reactivate"}
          </button>
        </form>
        {reactivateState?.error ? (
          <p className="max-w-[220px] text-right text-xs text-red-700">
            {reactivateState.error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <form action={archiveFormAction} className="flex flex-col items-end gap-1">
        <input type="hidden" name="clientId" value={clientId} />
        <input type="hidden" name="clientPackageId" value={clientPackageId} />

        {showReasonField ? (
          <input
            type="text"
            name="archiveReason"
            maxLength={500}
            placeholder="Reason (optional)"
            className="w-48 rounded-lg border border-[var(--brand-border)] px-2 py-1 text-xs"
          />
        ) : (
          <button
            type="button"
            onClick={() => setShowReasonField(true)}
            className="text-xs text-slate-500 underline decoration-dotted hover:text-slate-700"
          >
            Add a reason (optional)
          </button>
        )}

        <button
          type="submit"
          disabled={archivePending}
          className="whitespace-nowrap rounded-full border border-[var(--brand-border)] px-3 py-1 text-xs font-medium text-slate-600 hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {archivePending ? "Archiving..." : "Archive"}
        </button>
      </form>
      {archiveState?.error ? (
        <p className="max-w-[220px] text-right text-xs text-red-700">{archiveState.error}</p>
      ) : null}
    </div>
  );
}
