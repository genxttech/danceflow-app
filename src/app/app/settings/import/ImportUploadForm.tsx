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
    return sourceSystem === "mindbody"
      ? "Import Mindbody sales, payments, refunds, and chargebacks as historical records only. No charge is recreated."
      : "Import payments after clients and appointments.";
  }
  if (importType === "packages") {
    if (sourceSystem === "wellnessliving") {
      return "Import current package and pass balances after clients. Historical attendance will not deduct the imported balance again.";
    }
    if (sourceSystem === "mindbody") {
      return "Import Mindbody pricing options and client services after clients. Visits Remaining is preserved as the current balance, and historical visits will not deduct it again.";
    }
    return "Upload packages for mapping and reconciliation preparation.";
  }
  if (importType === "memberships") {
    if (sourceSystem === "wellnessliving") {
      return "Import WellnessLiving memberships, current billing periods, and payment state after clients. AutoPay credentials are never imported.";
    }
    if (sourceSystem === "mindbody") {
      return "Import Mindbody contracts, current billing periods, and payment state after clients. Frozen status is preserved, but stored cards and AutoPay credentials are never imported.";
    }
    return "Upload memberships for mapping and reconciliation preparation.";
  }
  if (importType === "attendance") {
    if (sourceSystem === "wellnessliving") {
      return "Import historical attended, no-show, and cancelled states after appointments. Package and membership balances are not deducted again.";
    }
    if (sourceSystem === "mindbody") {
      return "Import Mindbody visits after appointments, classes, and enrollments. Attended, no-show, late-cancel, and cancelled states are preserved without deducting balances again; waitlist rows are surfaced for review.";
    }
    return "Upload historical attendance after appointments.";
  }
  if (importType === "account_credits") {
    if (sourceSystem === "wellnessliving") {
      return "Import historical account-credit ledger activity after clients and payments.";
    }
    if (sourceSystem === "mindbody") {
      return "Import Mindbody account balances, credits, debits, and gift-card activity after clients and payments. Source transaction IDs keep reruns safe.";
    }
    return "Upload account credits for reconciliation preparation.";
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
    if (importType === "packages" && sourceSystem === "mindbody") {
      return "Start with Dry Run. Import Mindbody clients first, then review pricing-option, client-service, usage-type, and remaining-visit matches in this same workflow.";
    }
    if (importType === "memberships" && sourceSystem === "wellnessliving") {
      return "Start with Dry Run. Confirm current periods and payment status before live execution.";
    }
    if (importType === "memberships" && sourceSystem === "mindbody") {
      return "Start with Dry Run. Review contract status, current period, amount due, amount paid, frozen state, and future billing setup in this same workflow.";
    }
    if (importType === "products" && sourceSystem === "square") {
      return "Start with Dry Run. Each row should represent one Square item variation.";
    }
    return "Upload one CSV at a time for the smoothest review.";
  }, [importType, sourceSystem]);

  return (
    <form action={formAction} className="rounded-2xl border border-[#E9D5FF] bg-white p-5 shadow-sm md:p-6">
      {parentBatchId ? (
        <input type="hidden" name="parentBatchId" value={parentBatchId} />
      ) : null}

      <div className="flex flex-col gap-2">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-700">
          {isRetry ? "Retry import" : "Next action"}
        </p>
        <h3 className="text-xl font-semibold text-[#2C1838]">
          {isRetry ? "Upload corrected file" : "Choose and upload one CSV"}
        </h3>
        <p className="text-sm text-slate-600">
          {isRetry
            ? "Use a corrected CSV to continue fixing this import without losing the original history."
            : "Choose the source, select what you are importing, and start with a review pass before making live changes."}
        </p>
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
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
              Packages{["wellnessliving", "mindbody"].includes(sourceSystem) ? " — supported" : " — mapping preparation"}
            </option>
            <option value="memberships">
              Memberships{["wellnessliving", "mindbody"].includes(sourceSystem) ? " — supported" : " — mapping preparation"}
            </option>
            <option value="attendance">
              Attendance{["wellnessliving", "mindbody"].includes(sourceSystem) ? " — supported" : " — mapping preparation"}
            </option>
            <option value="account_credits">
              Account Credits{["wellnessliving", "mindbody"].includes(sourceSystem) ? " — supported" : " — mapping preparation"}
            </option>
            <option value="products">Retail Products{sourceSystem === "square" ? " — supported" : " — mapping preparation"}</option>
            <option value="inventory">Inventory — mapping preparation</option>
            <option value="retail_orders">Retail Orders — mapping preparation</option>
            <option value="digital_entitlements">Digital Entitlements — mapping preparation</option>
          </select>
          <p className="mt-1 text-xs text-slate-500">{importTypeHelper(importType, sourceSystem)}</p>
        </div>

        <details className="md:col-span-2 rounded-xl border border-slate-200 bg-slate-50 p-4">
          <summary className="cursor-pointer text-sm font-semibold text-[#5B197A]">
            Advanced import behavior
          </summary>
          <div className="mt-4">
            <label htmlFor="mode" className="mb-1 block text-sm font-medium text-[#2C1838]">
              How should this run?
            </label>
            <select
              id="mode"
              name="mode"
              value={mode}
              onChange={(event) => setMode(event.target.value)}
              className="w-full rounded-xl border border-slate-300 px-3 py-2"
            >
              <option value="dry_run">Dry Run — review only</option>
              <option value="create_only">Create Only</option>
              <option value="create_or_update">Create or Update</option>
            </select>
            <p className="mt-1 text-xs text-slate-500">{modeHelper(mode)}</p>
          </div>
        </details>
      </div>

      <div className="mt-5 rounded-xl border border-violet-200 bg-violet-50 px-4 py-3">
        <p className="text-sm font-semibold text-[#2C1838]">What happens next</p>
        <p className="mt-1 text-sm text-[#6F5A7A]">{recommendation}</p>
      </div>

      <div className="mt-5">
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
          className="rounded-xl bg-[#5B197A] px-5 py-3 text-sm font-semibold text-white shadow-sm hover:bg-[#491362] disabled:opacity-60"
        >
          {pending ? "Uploading..." : submitLabel}
        </button>
      </div>
    </form>
  );
}