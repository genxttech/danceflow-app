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
  if (sourceSystem === "wellnessliving") {
    return "Use for WellnessLiving exports; source-specific mappings will be reused as support expands.";
  }
  if (sourceSystem === "pike13") {
    return "Use for Pike13 exports and assisted mapping review.";
  }
  if (sourceSystem === "square") {
    return "Recommended for retail catalog, inventory, order, customer, and payment exports.";
  }
  if (sourceSystem === "vagaro") {
    return "Best for exported Vagaro CSV files.";
  }
  if (sourceSystem === "spreadsheet") {
    return "Use for studio-prepared spreadsheets or exports combined from multiple systems.";
  }
  if (sourceSystem === "studio_director") {
    return "Use this when the CSV came from Studio Director.";
  }
  if (sourceSystem === "custom") {
    return "Use this when your file does not match a standard export.";
  }
  return "Use this for a standard CSV file.";
}

function importTypeHelper(importType: string, sourceSystem: string) {
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
    return sourceSystem === "wellnessliving"
      ? "Import WellnessLiving session passes and Visits Remaining after clients. Current remaining balances are preserved without re-deducting historical attendance."
      : "Upload package definitions and balances for mapping preparation.";
  }
  if (importType === "memberships") {
    return sourceSystem === "wellnessliving"
      ? "Import WellnessLiving memberships, current billing periods, and payment state after clients. AutoPay credentials are never imported."
      : "Upload memberships for mapping and reconciliation preparation.";
  }
  if (importType === "attendance") {
    return sourceSystem === "wellnessliving"
      ? "Import historical attended, no-show, and cancelled states after appointments. Package and membership balances are not deducted again."
      : "Upload historical attendance after appointments.";
  }
  if (importType === "account_credits") {
    return sourceSystem === "wellnessliving"
      ? "Import historical account-credit ledger activity after clients and payments."
      : "Upload account credits for reconciliation preparation.";
  }
  if (importType === "products") {
    return sourceSystem === "square"
      ? "Square catalog and variation imports now support dry-run validation and live execution."
      : "Import retail catalog basics such as SKU, name, price, category, and active status.";
  }
  if (importType === "inventory") {
    return "Prepare quantity and low-stock reconciliation after products are mapped.";
  }
  if (importType === "retail_orders") {
    return "Prepare historical retail sales after clients, products, and payments are available.";
  }
  if (importType === "digital_entitlements") {
    return "Prepare existing digital-access rights after products and client identities are mapped.";
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
    if (importType === "packages" && sourceSystem === "wellnessliving") {
      return "Start with Dry Run. Import WellnessLiving clients before package balances.";
    }
    if (importType === "memberships" && sourceSystem === "wellnessliving") {
      return "Start with Dry Run. Confirm current periods and payment status before live execution.";
    }
    if (importType === "products" && sourceSystem === "square") {
      return "Start with Dry Run. Each row should represent one Square item variation.";
    }
    return "Upload one CSV at a time for the smoothest review.";
  }, [importType, sourceSystem]);

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
            <option value="wellnessliving">WellnessLiving</option>
            <option value="pike13">Pike13</option>
            <option value="square">Square</option>
            <option value="vagaro">Vagaro</option>
            <option value="studio_director">Studio Director</option>
            <option value="spreadsheet">Spreadsheet</option>
            <option value="custom">Other / Custom</option>
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
            <option value="packages">
              Packages{sourceSystem === "wellnessliving" ? " — supported" : " — mapping preparation"}
            </option>
            <option value="memberships">
              Memberships{sourceSystem === "wellnessliving" ? " — supported" : " — mapping preparation"}
            </option>
            <option value="attendance">
              Attendance{sourceSystem === "wellnessliving" ? " — supported" : " — mapping preparation"}
            </option>
            <option value="account_credits">
              Account Credits{sourceSystem === "wellnessliving" ? " — supported" : " — mapping preparation"}
            </option>
            <option value="products">Retail Products{sourceSystem === "square" ? " — supported" : " — mapping preparation"}</option>
            <option value="inventory">Inventory — mapping preparation</option>
            <option value="retail_orders">Retail Orders — mapping preparation</option>
            <option value="digital_entitlements">Digital Entitlements — mapping preparation</option>
          </select>
          <p className="mt-1 text-xs text-slate-500">{importTypeHelper(importType, sourceSystem)}</p>
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
          <li>Retail data should follow clients: products, inventory, orders, then digital entitlements.</li>
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