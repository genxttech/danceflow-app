"use client";

import { useActionState, useMemo, useState } from "react";
import {
  createImportBatchAction,
  type ImportActionState,
} from "./actions";

const initialState: ImportActionState = {
  error: "",
};

type ImportUploadFormProps = {
  defaultSourceSystem?: string;
  defaultImportType?: string;
  defaultMode?: string;
  parentBatchId?: string | null;
  submitLabel?: string;
  helperText?: string;
};

function sourceHelper(sourceSystem: string) {
  if (sourceSystem === "mindbody") {
    return "Best for exported Mindbody CSV files.";
  }
  if (sourceSystem === "vagaro") {
    return "Best for exported Vagaro CSV files.";
  }
  if (sourceSystem === "studio_director") {
    return "Use this when the CSV came from Studio Director.";
  }
  if (sourceSystem === "custom") {
    return "Use this when your file does not match a standard export.";
  }
  return "Use this for a standard CSV file.";
}

function importTypeHelper(importType: string) {
  if (importType === "clients") {
    return "Recommended first. Import names, contact info, notes, and client history.";
  }
  if (importType === "instructors") {
    return "Import teaching staff after clients.";
  }
  if (importType === "appointments") {
    return "Import schedules after clients and instructors are already in place.";
  }
  if (importType === "payments") {
    return "Import payment history after clients are already in place.";
  }
  if (importType === "packages") {
    return "Package import support can be added later.";
  }
  if (importType === "memberships") {
    return "Membership import support can be added later.";
  }
  return "";
}

function modeHelper(mode: string) {
  if (mode === "dry_run") {
    return "Checks the file and shows what needs attention before anything is imported.";
  }
  if (mode === "create_only") {
    return "Only adds new records. Existing matches will be skipped.";
  }
  return "Adds new records and updates existing matches when the importer finds them.";
}

export default function ImportUploadForm({
  defaultSourceSystem = "generic_csv",
  defaultImportType = "clients",
  defaultMode = "dry_run",
  parentBatchId,
  submitLabel = "Create Import Batch",
  helperText = "Start with one CSV file per batch. Dry run is recommended first.",
}: ImportUploadFormProps) {
  const [state, formAction, pending] = useActionState(
    createImportBatchAction,
    initialState
  );

  const [sourceSystem, setSourceSystem] = useState(defaultSourceSystem);
  const [importType, setImportType] = useState(defaultImportType);
  const [mode, setMode] = useState(defaultMode);

  const isRetry = Boolean(parentBatchId);

  const recommendation = useMemo(() => {
    if (importType === "clients") {
      return "Great starting point for a new studio migration.";
    }
    if (importType === "instructors") {
      return "Best done after clients so schedule references are easier to review.";
    }
    if (importType === "appointments") {
      return "Best done after clients and instructors are already imported.";
    }
    if (importType === "payments") {
      return "Best done after clients are already imported.";
    }
    return "Upload one CSV at a time for the smoothest review.";
  }, [importType]);

  return (
    <form action={formAction} className="rounded-2xl border bg-white p-6 shadow-sm">
      {parentBatchId ? (
        <input type="hidden" name="parentBatchId" value={parentBatchId} />
      ) : null}

      <div className="flex flex-col gap-2">
        <h3 className="text-xl font-semibold text-slate-900">
          {isRetry ? "Upload Corrected File" : "Upload a CSV to Start"}
        </h3>
        <p className="text-sm text-slate-600">
          {isRetry
            ? "Use a corrected CSV to continue fixing this import without losing the original history."
            : "Choose the source, select what you are importing, and start with a review pass before making live changes."}
        </p>
      </div>

      <div className="mt-6 grid gap-6 md:grid-cols-3">
        <div>
          <label htmlFor="sourceSystem" className="mb-1 block text-sm font-medium">
            Where is this CSV from?
          </label>
          <select
            id="sourceSystem"
            name="sourceSystem"
            value={sourceSystem}
            onChange={(event) => setSourceSystem(event.target.value)}
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          >
            <option value="generic_csv">Generic CSV</option>
            <option value="mindbody">Mindbody</option>
            <option value="vagaro">Vagaro</option>
            <option value="studio_director">Studio Director</option>
            <option value="custom">Custom</option>
          </select>
          <p className="mt-1 text-xs text-slate-500">{sourceHelper(sourceSystem)}</p>
        </div>

        <div>
          <label htmlFor="importType" className="mb-1 block text-sm font-medium">
            What are you importing?
          </label>
          <select
            id="importType"
            name="importType"
            value={importType}
            onChange={(event) => setImportType(event.target.value)}
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          >
            <option value="clients">Clients</option>
            <option value="instructors">Instructors</option>
            <option value="appointments">Appointments</option>
            <option value="payments">Payments</option>
            <option value="packages">Packages</option>
            <option value="memberships">Memberships</option>
          </select>
          <p className="mt-1 text-xs text-slate-500">{importTypeHelper(importType)}</p>
        </div>

        <div>
          <label htmlFor="mode" className="mb-1 block text-sm font-medium">
            How should this run?
          </label>
          <select
            id="mode"
            name="mode"
            value={mode}
            onChange={(event) => setMode(event.target.value)}
            className="w-full rounded-xl border border-slate-300 px-3 py-2"
          >
            <option value="dry_run">Dry Run</option>
            <option value="create_only">Create Only</option>
            <option value="create_or_update">Create or Update</option>
          </select>
          <p className="mt-1 text-xs text-slate-500">{modeHelper(mode)}</p>
        </div>
      </div>

      <div className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4">
        <p className="text-sm font-medium text-slate-900">Recommended next step</p>
        <p className="mt-2 text-sm text-slate-600">{recommendation}</p>
        <ul className="mt-3 space-y-1 text-sm text-slate-600">
          <li>Start with clients first whenever possible.</li>
          <li>Use Dry Run before importing live data.</li>
          <li>Upload one CSV at a time for the smoothest review.</li>
        </ul>
      </div>

      <div className="mt-6">
        <label htmlFor="csvFile" className="mb-1 block text-sm font-medium">
          Upload CSV File
        </label>
        <input
          id="csvFile"
          name="csvFile"
          type="file"
          accept=".csv,text/csv"
          required
          className="w-full rounded-xl border border-slate-300 px-3 py-2"
        />
        <p className="mt-1 text-xs text-slate-500">{helperText}</p>
      </div>

      {state.error ? (
        <div className="mt-6 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {state.error}
        </div>
      ) : null}

      <div className="mt-6 flex flex-wrap gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-xl bg-slate-900 px-4 py-2 text-white hover:bg-slate-800 disabled:opacity-60"
        >
          {pending ? "Uploading..." : submitLabel}
        </button>
      </div>
    </form>
  );
}