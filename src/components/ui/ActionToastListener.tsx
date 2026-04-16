"use client";

import { useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AlertCircle, CheckCircle2, X } from "lucide-react";

const SUCCESS_MESSAGES: Record<string, string> = {
  client_created: "Client created.",
  client_updated: "Client updated.",
  client_archived: "Client archived.",
  lead_converted: "Lead converted to active client.",
  lead_archived: "Lead archived.",
  lead_activity_created: "Lead activity added.",
  followup_completed: "Follow-up marked complete.",
  appointment_created: "Appointment created.",
  appointment_updated: "Appointment updated.",
  appointment_cancelled: "Appointment cancelled.",
  appointment_attended: "Appointment marked attended.",
  appointment_no_show: "Appointment marked no-show.",
  payment_logged: "Payment logged.",
  settings_saved: "Settings saved.",
};

const ERROR_MESSAGES: Record<string, string> = {
  appointment_missing: "Appointment could not be found.",
  appointment_cancel_failed: "Could not cancel appointment.",
  appointment_attended_failed: "Could not mark appointment attended.",
  appointment_no_show_failed: "Could not mark appointment no-show.",
  appointment_series_cancel_failed: "Could not cancel the recurring series.",
  client_archive_failed: "Could not archive client.",
  lead_update_failed: "Could not update lead.",
  lead_activity_create_failed: "Could not add lead activity.",
  followup_complete_failed: "Could not complete follow-up.",
  payment_create_failed: "Could not log payment.",
  unauthorized: "You do not have permission to do that.",
  unknown: "Something went wrong.",
};

type ToastState =
  | {
      kind: "success" | "error";
      message: string;
    }
  | null;

export default function ActionToastListener() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const [visible, setVisible] = useState(false);

  const toast = useMemo<ToastState>(() => {
    const successCode = searchParams.get("success");
    const errorCode = searchParams.get("error");

    if (successCode) {
      const message = SUCCESS_MESSAGES[successCode];
      if (message) {
        return { kind: "success", message };
      }
    }

    if (errorCode) {
      const message = ERROR_MESSAGES[errorCode] ?? decodeURIComponent(errorCode);
      if (message) {
        return { kind: "error", message };
      }
    }

    return null;
  }, [searchParams]);

  useEffect(() => {
    if (!toast?.message) return;

    setVisible(true);

    const hideTimer = window.setTimeout(() => {
      setVisible(false);
    }, 3200);

    const clearTimer = window.setTimeout(() => {
      const next = new URLSearchParams(searchParams.toString());
      next.delete("success");
      next.delete("error");

      const query = next.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    }, 3600);

    return () => {
      window.clearTimeout(hideTimer);
      window.clearTimeout(clearTimer);
    };
  }, [toast, pathname, router, searchParams]);

  if (!toast || !visible) return null;

  const isSuccess = toast.kind === "success";

  return (
    <div className="pointer-events-none fixed right-4 top-4 z-[100] max-w-sm">
      <div
        className={`pointer-events-auto flex items-start gap-3 rounded-2xl border bg-white px-4 py-3 shadow-lg ${
          isSuccess ? "border-green-200" : "border-red-200"
        }`}
      >
        {isSuccess ? (
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-green-600" />
        ) : (
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
        )}

        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-slate-900">{toast.message}</p>
        </div>

        <button
          type="button"
          onClick={() => setVisible(false)}
          className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          aria-label="Dismiss notification"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}