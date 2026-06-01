"use client";

import { useMemo, useState, type FormEvent } from "react";
import {
  type SmsPermissionRow,
  canSendSms,
  normalizeSmsPhone,
  smsConsentLabel,
} from "@/lib/sms/compliance";

type ClientSendSmsCardProps = {
  clientId: string;
  phone: string | null | undefined;
  permission?: SmsPermissionRow | null;
  canManage?: boolean;
};

function sendDisabledReason(args: {
  canManage: boolean;
  phone: string | null;
  permission?: SmsPermissionRow | null;
}) {
  if (!args.canManage) return "Ask a studio owner, admin, or front desk user to send texts.";
  if (!args.phone) return "Add a valid phone number before sending a text.";
  if (!args.permission) return "Save SMS consent before sending a text.";
  if (!canSendSms(args.permission)) return "This contact must be opted in before you send a text.";

  return null;
}

export function ClientSendSmsCard({
  clientId,
  phone,
  permission,
  canManage = false,
}: ClientSendSmsCardProps) {
  const [message, setMessage] = useState("");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);

  const normalizedPhone = phone ? normalizeSmsPhone(phone) : null;
  const disabledReason = useMemo(
    () => sendDisabledReason({ canManage, phone: normalizedPhone, permission }),
    [canManage, normalizedPhone, permission],
  );
  const canSubmit = !disabledReason && message.trim().length > 0 && !isSending;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!canSubmit) return;

    setIsSending(true);
    setStatusMessage(null);
    setErrorMessage(null);

    try {
      const response = await fetch("/api/sms/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          clientId,
          body: message,
        }),
      });

      const payload = await response.json().catch(() => null) as
        | { ok?: boolean; message?: string; error?: string }
        | null;

      if (!response.ok || !payload?.ok) {
        setErrorMessage(payload?.error ?? "The text could not be sent.");
        return;
      }

      setMessage("");
      setStatusMessage(payload.message ?? "Text queued for sending.");
    } catch {
      setErrorMessage("The text could not be sent. Please try again.");
    } finally {
      setIsSending(false);
    }
  }

  return (
    <section className="rounded-3xl border border-[var(--brand-border)] bg-white p-5 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-[var(--brand-muted)]">
            Text message
          </p>
          <h2 className="mt-2 text-xl font-bold text-[var(--brand-text)]">Send SMS</h2>
          <p className="mt-2 text-sm leading-6 text-[var(--brand-muted)]">
            Send an individual text after the client has opted in.
          </p>
        </div>

        <span className="rounded-2xl border border-[var(--brand-border)] bg-[var(--brand-page-bg)] px-3 py-2 text-sm font-bold text-[var(--brand-text)]">
          {smsConsentLabel(permission?.consent_status ?? "unknown")}
        </span>
      </div>

      {statusMessage ? (
        <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800">
          {statusMessage}
        </div>
      ) : null}

      {errorMessage ? (
        <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
          {errorMessage}
        </div>
      ) : null}

      {disabledReason ? (
        <p className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {disabledReason}
        </p>
      ) : null}

      <form onSubmit={handleSubmit} className="mt-5 space-y-4">
        <label className="block text-sm font-semibold text-[var(--brand-text)]">
          Message
          <textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            rows={4}
            maxLength={1200}
            placeholder="Example: Hi! This is a quick reminder about your lesson tomorrow."
            disabled={Boolean(disabledReason)}
            className="mt-2 w-full rounded-2xl border border-[var(--brand-border)] bg-white px-4 py-3 text-sm disabled:cursor-not-allowed disabled:bg-slate-50"
          />
        </label>

        <p className="text-xs leading-5 text-[var(--brand-muted)]">
          Tip: Keep texts brief and personal. DanceFlow adds opt-out language when needed.
        </p>

        <button
          type="submit"
          disabled={!canSubmit}
          className="rounded-2xl bg-[var(--brand-primary)] px-5 py-3 text-sm font-bold text-white shadow-sm hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSending ? "Sending..." : "Send text"}
        </button>
      </form>
    </section>
  );
}
